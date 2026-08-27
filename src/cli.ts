/**
 * Operator CLI. This is the tool you reach for when a recipe breaks — deliberately
 * usable with no Telegram credentials and, via --no-llm, with no model load at all.
 *
 * That last flag matters on this host: the GPU is shared with another project whose
 * models are pinned resident, and loading Scout evicts them. Extraction can be debugged
 * end-to-end without ever touching the GPU.
 */

import { loadConfig, requireTelegram, type Config } from './core/config.ts';
import { createBot, recentChats, sendText, verifyBot } from './telegram/bot.ts';
import { isErr, isOk } from './core/result.ts';
import { asTargetId, type Listing, type Target } from './core/types.ts';
import { fetchPage, closeBrowser } from './fetch/index.ts';
import { applyRecipe } from './extract/selectors.ts';
import { condensePage } from './extract/condense.ts';
import { generateRecipe } from './extract/generate.ts';
import { loadAllTargets, loadRecipe, loadTarget, saveRecipe } from './extract/recipe.ts';
import { openStore, closeStore } from './store/db.ts';
import { pollTarget } from './pipeline/poll.ts';
import { rejectReason } from './llm/score.ts';
import { modelExists, modelSupportsVision, type OllamaOptions } from './llm/ollama.ts';
import { describeIntent, parseIntent } from './discover/intent.ts';
import { discoverSearchUrl } from './discover/search.ts';

const USAGE = `scout — site-agnostic listing watcher

  yarn scout list                          show configured targets
  yarn scout fetch <url>                   fetch a url and report what came back
  yarn scout generate <target-id>          write recipes/<id>.recipe.yaml from the live page
  yarn scout run <target-id> [--no-llm]    fetch, extract, filter and report (stateless)
  yarn scout poll <target-id> [--no-llm]   full pipeline incl. dedupe + scoring (writes db)
  yarn scout doctor                        check ollama, model and vision availability
  yarn scout check-telegram                verify bot token + chat id, send a test message
  yarn scout discover "<description>"      find a search URL from plain English

  --no-llm   skip model calls entirely (no GPU load — leaves other models resident)
`;

async function main(): Promise<number> {
    const argv = process.argv.slice(2);
    const command = argv[0];

    if (command === undefined || command === '--help' || command === '-h') {
        process.stdout.write(USAGE);
        return 0;
    }

    const configResult = loadConfig();
    if (isErr(configResult)) {
        process.stderr.write(`config error: ${configResult.error.message}\n`);
        return 1;
    }
    const config = configResult.value;

    const ollama: OllamaOptions = {
        url: config.ollamaUrl,
        model: config.scoutModel,
        timeoutMs: config.ollamaTimeoutMs,
    };

    switch (command) {
        case 'list':
            return await cmdList(config.targetsDir);
        case 'doctor':
            return await cmdDoctor(ollama);
        case 'check-telegram':
            return await cmdCheckTelegram(config);
        case 'discover':
            return await cmdDiscover(argv.slice(1).join(' '), config, ollama);
        case 'fetch':
            return await cmdFetch(argv[1], config);
        case 'generate':
            return await cmdGenerate(argv[1], config, ollama);
        case 'run':
            return await cmdRun(argv[1], config, argv.includes('--no-llm'));
        case 'poll':
            return await cmdPoll(argv[1], config, ollama, argv.includes('--no-llm'));
        default:
            process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
            return 1;
    }
}

async function cmdList(targetsDir: string): Promise<number> {
    const { targets, errors } = await loadAllTargets(targetsDir);
    for (const e of errors) {
        process.stderr.write(`  ! ${e.message}\n`);
    }
    if (targets.length === 0) {
        process.stdout.write(`no targets in ${targetsDir}\n`);
        return errors.length > 0 ? 1 : 0;
    }
    for (const t of targets) {
        process.stdout.write(
            `${t.enabled ? '●' : '○'} ${t.id}\n    ${t.url}\n    every "${t.schedule}"  minScore ${t.notify.minScore}  photoGrade ${t.notify.photoGrade}\n`,
        );
    }
    return 0;
}

async function cmdDoctor(ollama: OllamaOptions): Promise<number> {
    process.stdout.write(`ollama url : ${ollama.url}\n`);

    const exists = await modelExists(ollama);
    if (!isOk(exists)) {
        process.stdout.write(`  ! ${exists.error.message}\n`);
        return 1;
    }
    process.stdout.write(`model      : ${ollama.model} ${exists.value ? 'FOUND' : 'MISSING'}\n`);
    if (!exists.value) {
        process.stdout.write(`  bake it with: scripts/bake-model.sh\n`);
        return 1;
    }

    const vision = await modelSupportsVision(ollama);
    process.stdout.write(
        `vision     : ${isOk(vision) ? (vision.value ? 'yes (photoGrade available)' : 'no (photoGrade will be skipped)') : 'unknown'}\n`,
    );
    return 0;
}

/**
 * Verify the Telegram credentials without starting the bot.
 *
 * Worth its own command because the long-polling service gives no useful feedback on a
 * bad token — it just fails at startup, and the distinction between "token wrong" and
 * "chat id wrong" is exactly what you need and cannot see from there. The chat check is
 * a real send, since getMe passing proves only the token, not that Scout can reach you.
 */
async function cmdCheckTelegram(config: Config): Promise<number> {
    const telegram = requireTelegram(config);
    if (isErr(telegram)) {
        process.stderr.write(`${telegram.error.message}\n`);
        return 1;
    }

    const scout = createBot(telegram.value);
    const identity = await verifyBot(scout);
    if (isErr(identity)) {
        process.stderr.write(`token   : REJECTED — ${identity.error.message}\n`);
        return 1;
    }
    process.stdout.write(`token   : ok (@${identity.value})\n`);

    const sent = await sendText(
        scout,
        '✅ <b>Scout</b> is wired up.\n\nSend /start to see what it can do.',
    );
    if (isErr(sent)) {
        process.stderr.write(`chat    : FAILED — ${sent.error.message}\n`);

        // The token is fine, so ask Telegram who HAS written to this bot. That turns an
        // ambiguous "chat not found" into either the correct id or proof that no
        // conversation exists yet.
        const chats = await recentChats(scout);
        if (isErr(chats)) {
            process.stderr.write(`  (could not read recent chats: ${chats.error.message})\n`);
        } else if (chats.value.length === 0) {
            process.stderr.write(
                `\n  Telegram has no record of anyone messaging @${identity.value}.\n` +
                    `  A bot cannot open a conversation you have never started, so:\n` +
                    `    1. open Telegram and send /start to @${identity.value}\n` +
                    `    2. run this command again\n`,
            );
        } else {
            process.stderr.write(`\n  Chats that have messaged this bot:\n`);
            for (const chat of chats.value) {
                process.stderr.write(`    TELEGRAM_CHAT_ID=${chat.id}   (${chat.label})\n`);
            }
            process.stderr.write(`\n  Put the right one in your env file and re-run.\n`);
        }
        return 1;
    }
    process.stdout.write('chat    : ok (check your phone)\n');
    return 0;
}

/**
 * Find a search URL from a description, showing every attempt.
 *
 * Verbose on purpose. Discovery guesses undocumented URL schemas, so the value is not just
 * the answer but the evidence for it — which constraints the site actually honoured.
 */
async function cmdDiscover(description: string, config: Config, ollama: OllamaOptions): Promise<number> {
    if (description.trim().length === 0) {
        process.stderr.write('usage: yarn scout discover "BMW estate under 15k, diesel, 2015+, Porto"\n');
        return 1;
    }

    const intent = await parseIntent(ollama, description);
    if (isErr(intent)) {
        process.stderr.write(`could not parse that: ${intent.error.message}\n`);
        return 1;
    }
    process.stdout.write(`understood : ${describeIntent(intent.value)}\n\n`);

    const outcome = await discoverSearchUrl(
        {
            ollama,
            minHostIntervalMs: config.minHostIntervalMs,
            respectRobots: config.respectRobots,
            onProgress: (m) => { process.stdout.write(`  ${m}\n`); },
        },
        intent.value,
    );
    await closeBrowser();

    if (isErr(outcome)) {
        process.stderr.write(`discovery failed: ${outcome.error.message}\n`);
        return 1;
    }

    process.stdout.write('\n--- attempts ---\n');
    for (const [i, a] of outcome.value.attempts.entries()) {
        process.stdout.write(`${i + 1}. ${a.candidate.site}\n   ${a.candidate.url}\n`);
        if (a.failure !== null) {
            process.stdout.write(`   FAILED: ${a.failure}\n`);
        } else if (a.verification !== null) {
            process.stdout.write(`   ${a.verification.summary.split('\n').join('\n   ')}\n`);
            process.stdout.write(`   score ${a.score.toFixed(2)}\n`);
        }
    }

    const best = outcome.value.best;
    if (best === null) {
        process.stderr.write('\nNo candidate produced a usable search. Paste a URL instead.\n');
        return 1;
    }
    process.stdout.write(
        `\n--- best ---\n${best.candidate.url}\n` +
            `${best.listings.length} listings, ` +
            `${best.verification?.looksFiltered === true ? 'filters applied' : 'FILTERS INCOMPLETE'}\n`,
    );
    return 0;
}

async function cmdFetch(url: string | undefined, config: Config): Promise<number> {
    if (url === undefined) {
        process.stderr.write('usage: yarn scout fetch <url>\n');
        return 1;
    }

    const result = await fetchPage(url, {
        mode: 'auto',
        minHostIntervalMs: config.minHostIntervalMs,
        respectRobots: config.respectRobots,
    });
    await closeBrowser();

    if (isErr(result)) {
        process.stderr.write(`fetch failed [${result.error.kind}]: ${result.error.message}\n`);
        return 1;
    }

    const { page, escalated } = result.value;
    const condensed = condensePage(page.body, page.contentType);
    process.stdout.write(
        `status     : ${page.status}\n` +
            `via        : ${page.via}${escalated ? ' (escalated from http)' : ''}\n` +
            `bytes      : ${Buffer.byteLength(page.body)}\n` +
            `condensed  : ${condensed.kind}, ${condensed.condensedBytes} bytes ` +
            `(${Math.round((1 - condensed.condensedBytes / Math.max(1, condensed.originalBytes)) * 100)}% smaller)\n`,
    );
    return 0;
}

async function cmdGenerate(id: string | undefined, config: Config, ollama: OllamaOptions): Promise<number> {
    if (id === undefined) {
        process.stderr.write('usage: yarn scout generate <target-id>\n');
        return 1;
    }

    const target = await loadTarget(config.targetsDir, id);
    if (isErr(target)) {
        process.stderr.write(`${target.error.message}\n`);
        return 1;
    }

    process.stdout.write(`fetching ${target.value.url} ...\n`);
    const fetched = await fetchPage(target.value.url, {
        mode: target.value.fetchMode,
        minHostIntervalMs: config.minHostIntervalMs,
        respectRobots: config.respectRobots,
    });
    await closeBrowser();

    if (isErr(fetched)) {
        process.stderr.write(`fetch failed [${fetched.error.kind}]: ${fetched.error.message}\n`);
        return 1;
    }

    process.stdout.write(`generating recipe with ${ollama.model} (this loads the model) ...\n`);
    const generated = await generateRecipe(ollama, {
        url: target.value.url,
        body: fetched.value.page.body,
        contentType: fetched.value.page.contentType,
        criteria: target.value.criteria,
        requiredFields: _filteredFields(target.value),
    });
    if (isErr(generated)) {
        process.stderr.write(`generation failed [${generated.error.kind}]: ${generated.error.message}\n`);
        return 1;
    }

    const saved = await saveRecipe(config.recipesDir, id, generated.value.recipe);
    if (isErr(saved)) {
        process.stderr.write(`${saved.error.message}\n`);
        return 1;
    }

    const { recipe } = generated.value;
    process.stdout.write(
        `\nwrote ${saved.value}\n` +
            `  mode   : ${recipe.mode}${recipe.source !== undefined ? ` (${recipe.source})` : ''}\n` +
            `  list   : ${recipe.list}\n` +
            `  fields : ${Object.keys(recipe.fields).join(', ')}\n` +
            `  notes  : ${generated.value.notes}\n\n` +
            `verify with: yarn scout run ${id} --no-llm\n`,
    );
    return 0;
}

async function cmdRun(id: string | undefined, config: Config, noLlm: boolean): Promise<number> {
    if (id === undefined) {
        process.stderr.write('usage: yarn scout run <target-id> [--no-llm]\n');
        return 1;
    }

    const target = await loadTarget(config.targetsDir, id);
    if (isErr(target)) {
        process.stderr.write(`${target.error.message}\n`);
        return 1;
    }

    const recipe = await loadRecipe(config.recipesDir, id);
    if (isErr(recipe)) {
        process.stderr.write(`${recipe.error.message}\n  run: yarn scout generate ${id}\n`);
        return 1;
    }

    const fetched = await fetchPage(target.value.url, {
        mode: target.value.fetchMode,
        minHostIntervalMs: config.minHostIntervalMs,
        respectRobots: config.respectRobots,
    });
    await closeBrowser();

    if (isErr(fetched)) {
        process.stderr.write(`fetch failed [${fetched.error.kind}]: ${fetched.error.message}\n`);
        return 1;
    }

    const extracted = applyRecipe(recipe.value, fetched.value.page);
    if (isErr(extracted)) {
        process.stderr.write(`extraction failed [${extracted.error.kind}]: ${extracted.error.message}\n`);
        return 1;
    }

    const listings = extracted.value;
    process.stdout.write(
        `via ${fetched.value.page.via}${fetched.value.escalated ? ' (escalated)' : ''}, ` +
            `extracted ${listings.length} listing(s)\n\n`,
    );

    if (listings.length === 0) {
        process.stderr.write(
            'extracted nothing — the recipe is probably stale.\n' +
                `  regenerate: yarn scout generate ${id}\n`,
        );
        return 1;
    }

    _reportListings(listings, target.value);

    if (noLlm) {
        process.stdout.write('\n--no-llm: skipping scoring (no model loaded)\n');
    }
    return 0;
}

/**
 * A full poll through the real pipeline, including the store. Distinct from `run`, which
 * deliberately stays stateless so repeated recipe debugging does not pollute the seen-set
 * — the first debug run would otherwise mark everything seen and every later run would
 * show zero new listings.
 */
async function cmdPoll(id: string | undefined, config: Config, ollama: OllamaOptions, noLlm: boolean): Promise<number> {
    if (id === undefined) {
        process.stderr.write('usage: yarn scout poll <target-id> [--no-llm]\n');
        return 1;
    }

    const target = await loadTarget(config.targetsDir, id);
    if (isErr(target)) {
        process.stderr.write(`${target.error.message}\n`);
        return 1;
    }

    const store = openStore(config.dbPath);
    if (isErr(store)) {
        process.stderr.write(`${store.error.message}\n`);
        return 1;
    }

    try {
        const report = await pollTarget(target.value, {
            config,
            ollama,
            store: store.value,
            ...(noLlm ? { noLlm: true } : {}),
        });
        await closeBrowser();

        if (isErr(report)) {
            process.stderr.write(`poll failed [${report.error.kind}]: ${report.error.message}\n`);
            return 1;
        }

        const r = report.value;
        process.stdout.write(
            `via ${r.via}${r.escalated ? ' (escalated)' : ''}\n` +
                `  extracted      ${r.extracted}\n` +
                `  passed filters ${r.passedFilters}\n` +
                `  NEW            ${r.fresh}\n` +
                `  judged         ${r.judged}\n` +
                `  would notify   ${r.notifications.length}\n`,
        );

        for (const n of r.notifications) {
            process.stdout.write(
                `\n  ★ ${n.listing.title ?? '(no title)'} — ${n.verdict.score.toFixed(2)} [${n.verdict.priceAssessment}]\n` +
                    `    ${n.verdict.reason}\n` +
                    (n.verdict.photoNotes !== null ? `    photo: ${n.verdict.photoNotes}\n` : '') +
                    `    ${n.listing.url}\n`,
            );
        }
        if (r.healed !== null) {
            process.stdout.write(
                `\n  ${r.healed.outcome === 'healed' ? '🔧 healed' : '⚠️  heal ' + r.healed.outcome}\n` +
                    `    ${r.healed.message.split('\n').join('\n    ')}\n`,
            );
        }
        for (const w of r.warnings) {
            process.stderr.write(`  ! ${w}\n`);
        }
        return 0;
    } finally {
        closeStore(store.value);
    }
}

/**
 * Which numeric fields this target actually filters on. Passed to the generator so it does
 * not pick a route that omits them and leave the filters silently inert.
 */
function _filteredFields(target: Target): readonly string[] {
    const fields: string[] = [];
    if (target.filters.price !== undefined) { fields.push('price'); }
    if (target.filters.year !== undefined) { fields.push('year'); }
    if (target.filters.km !== undefined) { fields.push('km (mileage)'); }
    return fields;
}

function _reportListings(listings: readonly Listing[], target: Target): void {
    let passed = 0;
    const rejectionCounts = new Map<string, number>();

    for (const listing of listings.slice(0, 10)) {
        const reason = rejectReason(listing, target.filters);
        const mark = reason === null ? 'PASS' : 'skip';
        process.stdout.write(
            `  [${mark}] ${listing.title ?? '(no title)'}\n` +
                `         ${listing.price !== null ? `${listing.price} ${listing.currency ?? ''}`.trim() : '(no price)'}` +
                ` | ${listing.year ?? '?'} | ${listing.km !== null ? `${listing.km} km` : '? km'}` +
                ` | ${listing.location ?? '?'}\n` +
                `         ${listing.url}\n` +
                (reason !== null ? `         rejected: ${reason}\n` : ''),
        );
    }

    for (const listing of listings) {
        const reason = rejectReason(listing, target.filters);
        if (reason === null) {
            passed += 1;
        } else {
            // Bucket by the rule, not the value, so the summary stays readable.
            const bucket = reason.split(' ')[0] ?? 'other';
            rejectionCounts.set(bucket, (rejectionCounts.get(bucket) ?? 0) + 1);
        }
    }

    if (listings.length > 10) {
        process.stdout.write(`  ... ${listings.length - 10} more not shown\n`);
    }
    const breakdown = [...rejectionCounts.entries()].map(([k, v]) => `${v} on ${k}`).join(', ');
    process.stdout.write(
        `\n${passed}/${listings.length} passed the deterministic filters` +
            (breakdown.length > 0 ? ` (rejected: ${breakdown})` : '') +
            '\n',
    );
}

main()
    .then((code) => {
        process.exitCode = code;
    })
    .catch((thrown: unknown) => {
        process.stderr.write(`unexpected: ${String(thrown)}\n`);
        process.exitCode = 1;
    });
