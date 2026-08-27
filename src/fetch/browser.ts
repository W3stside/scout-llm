/**
 * The expensive fetch path: real Chromium, for pages that defeat plain HTTP.
 *
 * Reached only when `fetchViaHttp` reports `blocked`, or when a target pins
 * `fetchMode: browser`. The cost is real — roughly 4s and several hundred MB versus
 * 200ms and 50MB — so this is a fallback, never the default.
 *
 * The browser is launched once and reused; each fetch gets a fresh *context*, which is
 * the isolation boundary that matters. A context carries its own cookie jar and storage,
 * so one site's tracking state can never be read by the next fetch, and a poisoned
 * context is discarded rather than accumulating across a long-running process.
 *
 * Network guard limits, stated: every HTTP(S) request the page makes is checked by name
 * AND by our own DNS resolution (_routeAllowed), but Chromium still resolves and connects
 * itself, so a re-resolution race remains theoretically open — and page.route cannot
 * intercept WebSockets at all, so hostile JS opening a ws:// to a private address is
 * stopped only by Chromium's own Private Network Access blocking and the container's
 * network posture, not by us. This is why the browser is the fallback path, never the
 * default, and why the scraper tier holds nothing worth stealing.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { Result } from '../core/result.ts';
import { err, messageOf, ok } from '../core/result.ts';
import { scoutError, type ScoutError } from '../core/types.ts';
import { hostGuardError, resolvesOnlyPublic } from './guard.ts';
import type { FetchedPage } from './http.ts';
import { classifyResponse } from './http.ts';
import { awaitHostSlot, DESKTOP_USER_AGENT } from './politeness.ts';

let _browser: Browser | null = null;

/**
 * Lazily launch the shared browser.
 *
 * The `--disable-blink-features=AutomationControlled` flag removes `navigator.webdriver`,
 * which is the single cheapest automation tell and the first thing bot-detection reads.
 *
 * Sandbox decision, stated: Chromium's renderer sandbox is REQUIRED by default. The
 * container grants no capabilities at all — an earlier comment here claimed SYS_ADMIN, and
 * was wrong — so the sandbox runs on unprivileged user namespaces, which the compose
 * file's seccomp profile (infra/scraper/seccomp-chromium.json) explicitly permits while
 * keeping cap_drop: ALL and no-new-privileges. If launch fails on a host that also blocks
 * unprivileged userns (Ubuntu 23.10+ with apparmor_restrict_unprivileged_userns), the
 * fallback is NOT silent: SCOUT_BROWSER_NO_SANDBOX=true is an explicit operator decision
 * to run hostile page JS with the container as the only boundary.
 */
async function _ensureBrowser(): Promise<Result<Browser, ScoutError>> {
    if (_browser !== null && _browser.isConnected()) {
        return ok(_browser);
    }
    const noSandbox = process.env['SCOUT_BROWSER_NO_SANDBOX'] === 'true';
    try {
        _browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage', // /dev/shm is small in containers; without this Chromium crashes on big pages
                ...(noSandbox ? ['--no-sandbox'] : []),
            ],
        });
        return ok(_browser);
    } catch (thrown: unknown) {
        return err(
            scoutError(
                'network',
                `chromium launch failed: ${messageOf(thrown)} — if this is a sandbox failure, ` +
                    'apply infra/scraper/seccomp-chromium.json (see docker-compose.yml) or set ' +
                    'SCOUT_BROWSER_NO_SANDBOX=true as a deliberate decision to rely on the container boundary',
                { cause: thrown },
            ),
        );
    }
}

/**
 * Whether a request the page makes may proceed. Chromium resolves DNS itself, so unlike
 * the HTTP path there is no connect-time hook here — instead the hostname is checked as a
 * string AND resolved through our own resolver, refusing any name whose answer includes a
 * private address. A hostile page cannot point the browser at 127.0.0.1, the docker
 * bridge, the metadata range, *.internal names, or a public-looking hostname that
 * resolves somewhere private. The residual gap is Chromium re-resolving between our
 * lookup and its own — narrower than string-only checking, and stated rather than silent.
 */
async function _routeAllowed(rawUrl: string): Promise<boolean> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        // about:blank, data:, blob: — internal to the page, no network egress.
        return true;
    }
    return resolvesOnlyPublic(parsed.hostname);
}

export type BrowserFetchOptions = {
    readonly minHostIntervalMs: number;
    readonly timeoutMs?: number;
    /**
     * Extra settle time after network idle. Some sites hydrate listings a beat after the
     * last request completes; without this the DOM is structurally there but empty.
     */
    readonly settleMs?: number;
};

export async function fetchViaBrowser(
    url: string,
    options: BrowserFetchOptions,
): Promise<Result<FetchedPage, ScoutError>> {
    // Stricter than _routeAllowed: a top-level navigation must be http(s) outright —
    // the data:/blob: pass-through only makes sense for a page's own subresources.
    let target: URL | null;
    try {
        target = new URL(url);
    } catch {
        target = null;
    }
    if (
        target === null ||
        (target.protocol !== 'http:' && target.protocol !== 'https:') ||
        hostGuardError(target.hostname) !== null ||
        !(await resolvesOnlyPublic(target.hostname))
    ) {
        return err(scoutError('network', `refusing browser fetch of ${url}: not a public http(s) destination`));
    }

    const launched = await _ensureBrowser();
    if (!launched.ok) {
        return launched;
    }

    await awaitHostSlot(url, options.minHostIntervalMs);

    const timeoutMs = options.timeoutMs ?? 45_000;
    let context: BrowserContext | null = null;

    try {
        context = await launched.value.newContext({
            userAgent: DESKTOP_USER_AGENT,
            locale: 'pt-PT',
            timezoneId: 'Europe/Lisbon',
            viewport: { width: 1440, height: 900 },
            // A real browser sends these; a mismatch between UA and viewport/locale is
            // exactly the inconsistency fingerprinting looks for.
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
        });

        const page = await context.newPage();

        // Images and fonts are the bulk of the bytes and none of the signal — we extract
        // from markup, and only ever need the image URL, never its pixels. Blocking them
        // roughly halves fetch time. Stylesheets are kept: some sites gate hydration on
        // CSS load, and blocking them can leave the listing container empty.
        //
        // The _routeAllowed check runs on EVERY request the page makes, not just the
        // navigation: hostile page JS gets its fetches to private addresses aborted here.
        // (Not WebSockets — page.route cannot intercept those; see the module note.)
        await page.route('**/*', async (route) => {
            const type = route.request().resourceType();
            if (type === 'image' || type === 'media' || type === 'font') {
                await route.abort().catch(() => undefined);
                return;
            }
            const allowed = await _routeAllowed(route.request().url()).catch(() => false);
            if (allowed) {
                await route.continue().catch(() => undefined);
            } else {
                await route.abort().catch(() => undefined);
            }
        });

        const response = await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: timeoutMs,
        });

        // networkidle is best-effort: a page with a long-poll or analytics beacon never
        // reaches it, and waiting the full timeout for that would be worse than
        // extracting from a DOM that is already complete.
        await page
            .waitForLoadState('networkidle', { timeout: 10_000 })
            .catch(() => undefined);

        if (options.settleMs !== undefined && options.settleMs > 0) {
            await page.waitForTimeout(options.settleMs);
        }

        const body = await page.content();
        const status = response?.status() ?? 0;
        const finalUrl = page.url();

        const verdict = classifyResponse(status === 0 ? 200 : status, body);
        if (verdict === 'blocked') {
            return err(
                scoutError('blocked', `browser fetch still blocked (status ${status})`, {
                    cause: { status, preview: body.slice(0, 200) },
                }),
            );
        }

        return ok({
            url,
            finalUrl,
            status: status === 0 ? 200 : status,
            body,
            contentType: 'text/html',
            via: 'browser',
        });
    } catch (thrown: unknown) {
        return err(scoutError('network', `browser fetch failed: ${messageOf(thrown)}`, { cause: thrown }));
    } finally {
        // Always dispose the context, even on the error path — a leaked context is a
        // leaked renderer process, and this loop runs indefinitely.
        if (context !== null) {
            await context.close().catch(() => undefined);
        }
    }
}

/** Release the shared browser. Called on shutdown; safe to call when never launched. */
export async function closeBrowser(): Promise<void> {
    if (_browser !== null) {
        await _browser.close().catch(() => undefined);
        _browser = null;
    }
}
