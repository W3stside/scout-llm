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
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { Result } from '../core/result.ts';
import { err, messageOf, ok } from '../core/result.ts';
import { scoutError, type ScoutError } from '../core/types.ts';
import type { FetchedPage } from './http.ts';
import { classifyResponse } from './http.ts';
import { awaitHostSlot, DESKTOP_USER_AGENT } from './politeness.ts';

let _browser: Browser | null = null;

/**
 * Lazily launch the shared browser.
 *
 * The `--disable-blink-features=AutomationControlled` flag removes `navigator.webdriver`,
 * which is the single cheapest automation tell and the first thing bot-detection reads.
 * We deliberately do NOT pass --no-sandbox: the container grants SYS_ADMIN precisely so
 * Chromium's own sandbox can run, keeping hostile page JS inside its renderer.
 */
async function _ensureBrowser(): Promise<Result<Browser, ScoutError>> {
    if (_browser !== null && _browser.isConnected()) {
        return ok(_browser);
    }
    try {
        _browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage', // /dev/shm is small in containers; without this Chromium crashes on big pages
            ],
        });
        return ok(_browser);
    } catch (thrown: unknown) {
        return err(scoutError('network', `chromium launch failed: ${messageOf(thrown)}`, { cause: thrown }));
    }
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
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (type === 'image' || type === 'media' || type === 'font') {
                void route.abort();
            } else {
                void route.continue();
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
