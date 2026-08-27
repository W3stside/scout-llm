/**
 * Finding a search URL from a plain-English description.
 *
 * The model proposes URLs from what it knows about classified sites. That knowledge is
 * real but unreliable — query-parameter schemas are undocumented, site-specific and change
 * — so a proposal is treated as a hypothesis, never an answer. Each candidate is fetched,
 * extracted and checked against the shopper's stated numbers, and only a URL whose results
 * actually respect them is offered.
 *
 * The correction loop is what makes this usable at all: "price cap not applied, only 31%
 * conform" sends the model back with a specific fault to fix rather than another blind
 * guess at the same schema.
 *
 * Cost is real and bounded deliberately. Every attempt is a page fetch plus a recipe
 * generation, so MAX_ATTEMPTS is small and per-host rate limiting still applies.
 */

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import { err, isErr, ok } from '../core/result.ts';
import { hostOf } from '../core/url.ts';
import { scoutError, type Listing, type Recipe, type ScoutError } from '../core/types.ts';
import { chatStructured, type OllamaOptions } from '../llm/ollama.ts';
import { fetchPage, type FetchedPage } from '../fetch/index.ts';
import { generateRecipe } from '../extract/generate.ts';
import { applyRecipe } from '../extract/selectors.ts';
import { describeIntent, type SearchIntent } from './intent.ts';
import { retryHint, scoreCandidate, verifyAgainstIntent, type Verification } from './verify.ts';
import { SEED_SEARCH_URLS, describeExamples, describeSiteMap, mapSite } from './ground.ts';

/** Page fetches are the expensive, impolite part; three is enough to correct one mistake. */
export const MAX_ATTEMPTS = 3;

/**
 * Phase one: which SITE. This is the part the model's memory is actually good at — it
 * reliably knows standvirtual.com and olx.pt serve Portuguese cars. It is asked for nothing
 * else here, because a URL proposed in the same breath would be invented.
 */
const SiteChoiceSchema = z.object({
    sites: z
        .array(z.string())
        .describe('Two or three bare hostnames, best first, e.g. ["standvirtual.com", "olx.pt"]'),
});

/**
 * Phase two: which URL, chosen against the site's real published paths.
 */
const CandidateSchema = z.object({
    url: z.string().describe('Full https URL of a SEARCH RESULTS page'),
    site: z.string().describe('Bare hostname'),
    reasoning: z.string().describe('One sentence: why this path and these parameters'),
});

const SITE_PROMPT = `You name the classified-listing SITES that serve a shopper's request.

Return two or three bare hostnames, best first, on genuinely different operators so one
site being unusable does not sink every attempt.

Prefer the regional site for the country given. Portugal: standvirtual.com and olx.pt for
cars, olx.pt for general goods. UK: autotrader.co.uk, gumtree.com. Spain: coches.net,
wallapop.com. Germany: mobile.de, kleinanzeigen.de.

Name only sites you are confident exist. Hostname only — no path, no scheme, no query.`;

const URL_PROMPT = `You build a SEARCH RESULTS URL for one specific site.

You are given the paths that site actually publishes on its own homepage. This matters:
your memory of URL schemas is unreliable, and an invented path 404s. For olx.pt a plausible
guess is /autos/bmw; the real path is /carros-motos-e-barcos/carros/bmw. CHOOSE from the
real paths given. Do not invent one.

- Start from the listed path that best matches the category, then narrow it if the site's
  own convention makes that obvious (a brand segment appended to a category path).
- Query parameters are the one thing you may have to guess, because navigation links rarely
  carry filters. When search URLs KNOWN TO WORK on this site are shown, do not guess at all:
  copy their parameter syntax exactly — names, bracket structure, indexed arrays, :to/:from
  suffixes — substituting only the shopper's values, and dropping parameters the shopper
  did not ask for. Otherwise, where the site's observed parameters are listed, use those
  names. Where neither is available, prefer FEWER parameters: an unfiltered results page is
  recoverable — Scout's own filters still apply — but a wrong path returns nothing at all.
- The result must be a SEARCH RESULTS page with many listings, not a single listing and not
  the homepage.

When told a previous attempt failed, change what failed. A 404 means the PATH was wrong —
pick a different one from the list. A constraint reported as NOT applied means a PARAMETER
name was wrong — rename it or drop it.`;

export type Candidate = {
    readonly url: string;
    readonly site: string;
    readonly reasoning: string;
};

export type Attempt = {
    readonly candidate: Candidate;
    readonly listings: readonly Listing[];
    readonly recipe: Recipe | null;
    readonly verification: Verification | null;
    readonly score: number;
    /** Why this attempt produced nothing usable, when it did not. */
    readonly failure: string | null;
};

export type DiscoveryOutcome = {
    readonly best: Attempt | null;
    readonly attempts: readonly Attempt[];
    readonly intent: SearchIntent;
};

export type DiscoverDeps = {
    readonly ollama: OllamaOptions;
    readonly minHostIntervalMs: number;
    readonly respectRobots: boolean;
    /** Progress callback — discovery takes minutes, so silence is not acceptable. */
    readonly onProgress?: (message: string) => Promise<void> | void;
    /** Verified search URLs from already-saved targets — the best grounding there is,
     *  because each one demonstrably worked on its site. Merged with the seed list. */
    readonly knownSearchUrls?: readonly string[];
};

/** Phase one — sites only, from memory, which is where memory is trustworthy. */
async function _chooseSites(
    deps: DiscoverDeps,
    intent: SearchIntent,
): Promise<Result<readonly string[], ScoutError>> {
    const choice = await chatStructured(
        deps.ollama,
        'extract',
        [
            { role: 'system', content: SITE_PROMPT },
            {
                role: 'user',
                content: `Shopper wants: ${describeIntent(intent)}\n\nCountry hint: ${intent.country ?? 'not stated'}`,
            },
        ],
        SiteChoiceSchema,
    );
    if (isErr(choice)) {
        return choice;
    }
    // Normalize away anything that slipped through as a URL rather than a hostname, and
    // cap the count outright — every extra site is another homepage fetch, so a model
    // that rambles must not be able to turn one /add into a crawl.
    const sites = choice.value.sites
        .map((s) => s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        .filter((s) => s.length > 0 && s.length <= 253 && s.includes('.'));
    return ok([...new Set(sites)].slice(0, 4));
}

/** Phase two — a URL for one site, chosen against paths that site really publishes. */
async function _proposeUrl(
    deps: DiscoverDeps,
    intent: SearchIntent,
    site: string,
    siteMapText: string,
    history: readonly { url: string; problem: string }[],
): Promise<Result<Candidate, ScoutError>> {
    const historyBlock =
        history.length === 0
            ? ''
            : `\n\nATTEMPTS THAT ALREADY FAILED — propose something DIFFERENT:\n` +
              history.map((h) => `- ${h.url}\n  problem: ${h.problem}`).join('\n');

    const proposal = await chatStructured(
        deps.ollama,
        'extract',
        [
            { role: 'system', content: URL_PROMPT },
            {
                role: 'user',
                content:
                    `Site: ${site}\n\n${siteMapText}\n\n` +
                    `Shopper wants: ${describeIntent(intent)}\n\n` +
                    `Structured intent:\n${JSON.stringify(intent, null, 1)}` +
                    historyBlock,
            },
        ],
        CandidateSchema,
    );
    if (isErr(proposal)) {
        return proposal;
    }
    return ok({ ...proposal.value, site });
}

/**
 * Whether a proposed URL stays on the site the model was asked about.
 *
 * The model reads the site's own homepage before proposing, which makes the proposal an
 * injection→fetch channel: a hostile homepage can instruct the model to "search" anywhere.
 * Pinning the proposal to the site it was GIVEN turns that channel into a no-op — the
 * fetch that follows can only hit the domain the shopper was already going to be shown.
 */
function _isOnSite(candidateUrl: string, site: string): boolean {
    const host = hostOf(candidateUrl);
    if (host === null) {
        return false;
    }
    const bare = site.toLowerCase().replace(/^www\./, '');
    const candidate = host.replace(/^www\./, '');
    return candidate === bare || candidate.endsWith(`.${bare}`);
}

async function _tryCandidate(
    deps: DiscoverDeps,
    intent: SearchIntent,
    candidate: Candidate,
): Promise<Attempt> {
    const bare = (failure: string): Attempt => ({
        candidate,
        listings: [],
        recipe: null,
        verification: null,
        score: 0,
        failure,
    });

    let page: FetchedPage;
    const fetched = await fetchPage(candidate.url, {
        mode: 'auto',
        minHostIntervalMs: deps.minHostIntervalMs,
        respectRobots: deps.respectRobots,
    });
    if (isErr(fetched)) {
        return bare(`could not fetch: ${fetched.error.message}`);
    }
    page = fetched.value.page;

    const generated = await generateRecipe(deps.ollama, {
        url: candidate.url,
        body: page.body,
        contentType: page.contentType,
        criteria: describeIntent(intent),
        requiredFields: [
            ...(intent.priceMax !== null || intent.priceMin !== null ? ['price'] : []),
            ...(intent.yearMin !== null || intent.yearMax !== null ? ['year'] : []),
            ...(intent.kmMax !== null ? ['km (mileage)'] : []),
        ],
    });
    if (isErr(generated)) {
        return bare(`could not build a recipe: ${generated.error.message}`);
    }

    const extracted = applyRecipe(generated.value.recipe, page);
    if (isErr(extracted)) {
        return bare(`extraction failed: ${extracted.error.message}`);
    }

    const listings = extracted.value;
    const verification = verifyAgainstIntent(listings, intent);

    return {
        candidate,
        listings,
        recipe: generated.value.recipe,
        verification,
        score: scoreCandidate(listings, verification),
        failure: listings.length === 0 ? 'no listings on the page' : null,
    };
}

/**
 * Propose, try, verify, correct — until a candidate's results genuinely respect the stated
 * constraints, or the attempt budget runs out.
 *
 * Returns the best attempt even when none fully passed. A partially-filtered search is
 * still worth offering, provided the caller SHOWS why it is imperfect rather than
 * presenting it as a clean result.
 */
export async function discoverSearchUrl(
    deps: DiscoverDeps,
    intent: SearchIntent,
): Promise<Result<DiscoveryOutcome, ScoutError>> {
    const attempts: Attempt[] = [];
    const history: { url: string; problem: string }[] = [];
    const tried = new Set<string>();

    await deps.onProgress?.('Working out where to look…');
    const sites = await _chooseSites(deps, intent);
    if (isErr(sites)) {
        return sites;
    }
    if (sites.value.length === 0) {
        return err(scoutError('llm', 'model named no candidate sites'));
    }

    // Site maps are cached per host: re-fetching a homepage for every round would be both
    // slow and needlessly impolite to a site we are about to search anyway.
    const maps = new Map<string, string>();

    // Saved-target URLs first: a URL verified on THIS installation outranks a curated
    // seed harvested from someone's browser session months ago.
    const knownUrls = [...(deps.knownSearchUrls ?? []), ...SEED_SEARCH_URLS];

    for (let round = 0; round < MAX_ATTEMPTS; round += 1) {
        // Rotate sites across rounds. A second guess at a site whose schema we clearly do
        // not know is worth less than a first guess at one we might.
        const site = sites.value[round % sites.value.length];
        if (site === undefined) {
            break;
        }

        let siteMapText = maps.get(site);
        if (siteMapText === undefined) {
            await deps.onProgress?.(`Reading ${site} to learn its real URLs…`);
            const mapped = await mapSite(site, {
                minHostIntervalMs: deps.minHostIntervalMs,
                respectRobots: deps.respectRobots,
            });
            if (isErr(mapped)) {
                // A site we cannot even reach is not worth proposing URLs for.
                history.push({ url: `https://${site}/`, problem: `homepage unreachable: ${mapped.error.message}` });
                continue;
            }
            siteMapText = describeSiteMap(mapped.value);
            maps.set(site, siteMapText);
        }

        const grounding = `${siteMapText}${describeExamples(site, knownUrls)}`;
        const proposed = await _proposeUrl(deps, intent, site, grounding, history);
        if (isErr(proposed)) {
            return proposed;
        }
        const candidate = proposed.value;

        // Enforced, not requested: the URL must be on the site the model was given. The
        // site map it just read is hostile page content, and this check is what stops an
        // injected "actually, search on evil.example instead" from ever being fetched.
        if (!_isOnSite(candidate.url, site)) {
            history.push({
                url: candidate.url,
                problem: `not on ${site} — the URL must stay on the site you were given`,
            });
            continue;
        }

        // Enforced here, not merely requested in the prompt. Told "do not repeat these",
        // the model re-proposed a 404ing URL verbatim on the very next round and burned an
        // attempt on it. An instruction is not a constraint.
        if (tried.has(candidate.url)) {
            history.push({
                url: candidate.url,
                problem: 'you already proposed this exact URL and it failed — it must be different',
            });
            continue;
        }
        tried.add(candidate.url);

        await deps.onProgress?.(`Trying ${candidate.site}…`);
        const attempt = await _tryCandidate(deps, intent, candidate);
        attempts.push(attempt);

        if (attempt.failure === null && attempt.verification?.looksFiltered === true) {
            return ok({ best: attempt, attempts, intent });
        }

        history.push({
            url: candidate.url,
            problem:
                attempt.failure ??
                (attempt.verification !== null
                    ? retryHint(attempt.verification, attempt.listings)
                    : 'unknown failure'),
        });
    }

    // Nothing fully passed. Hand back the least-bad attempt rather than nothing, so the
    // caller can show it with its shortcomings stated.
    const best = attempts.reduce<Attempt | null>(
        (acc, a) => (acc === null || a.score > acc.score ? a : acc),
        null,
    );
    return ok({ best: best !== null && best.score > 0 ? best : null, attempts, intent });
}
