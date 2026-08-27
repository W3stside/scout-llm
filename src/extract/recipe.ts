/**
 * Loading targets and recipes off disk, and writing recipes back.
 *
 * Both are YAML and both are committed, but they are owned by different parties: you
 * write targets, the model writes recipes. Keeping them in separate files is what makes
 * `git diff recipes/` a meaningful signal — a change there means the site moved, and the
 * diff shows exactly which field mapping shifted.
 *
 * Recipes are written with a generated-file header so nobody hand-edits one and loses
 * the change to the next healing pass.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Result } from '../core/result.ts';
import { err, messageOf, ok, partition } from '../core/result.ts';
import {
    RecipeSchema,
    TargetSchema,
    scoutError,
    type Recipe,
    type ScoutError,
    type Target,
} from '../core/types.ts';

// --- Targets ------------------------------------------------------------------------

export async function loadTarget(targetsDir: string, id: string): Promise<Result<Target, ScoutError>> {
    const path = join(targetsDir, `${id}.yaml`);
    try {
        const raw = await readFile(path, 'utf8');
        return _parseTarget(raw, path);
    } catch (thrown: unknown) {
        return err(scoutError('config', `cannot read target ${id}: ${messageOf(thrown)}`, { cause: thrown }));
    }
}

/**
 * Load every target, reporting per-file failures rather than aborting.
 *
 * One malformed YAML file must not take the whole scheduler down — the other five saved
 * searches are still perfectly runnable, and the operator needs to hear about the broken
 * one specifically.
 */
export async function loadAllTargets(
    targetsDir: string,
): Promise<{ readonly targets: readonly Target[]; readonly errors: readonly ScoutError[] }> {
    let files: string[];
    try {
        files = (await readdir(targetsDir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    } catch (thrown: unknown) {
        return {
            targets: [],
            errors: [scoutError('config', `cannot read targets dir ${targetsDir}: ${messageOf(thrown)}`)],
        };
    }

    const results = await Promise.all(
        files.map(async (file) => {
            const path = join(targetsDir, file);
            try {
                return _parseTarget(await readFile(path, 'utf8'), path);
            } catch (thrown: unknown) {
                return err(scoutError('config', `cannot read ${file}: ${messageOf(thrown)}`, { cause: thrown }));
            }
        }),
    );

    const { values, errors } = partition(results);
    return { targets: values, errors };
}

function _parseTarget(raw: string, path: string): Result<Target, ScoutError> {
    let doc: unknown;
    try {
        doc = parseYaml(raw);
    } catch (thrown: unknown) {
        return err(scoutError('config', `${path} is not valid YAML: ${messageOf(thrown)}`, { cause: thrown }));
    }

    const parsed = TargetSchema.safeParse(doc);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return err(scoutError('config', `${path} is not a valid target: ${detail}`));
    }
    return ok(parsed.data);
}

export async function saveTarget(targetsDir: string, target: Target): Promise<Result<string, ScoutError>> {
    const path = join(targetsDir, `${target.id}.yaml`);
    try {
        await mkdir(targetsDir, { recursive: true });
        const header =
            `# Saved search. Hand-editable and committed.\n` +
            `# The matching recipes/${target.id}.recipe.yaml is model-generated — do not hand-edit that one.\n` +
            `#\n` +
            `# NOTE: adding a target here widens the dev container's egress allowlist by exactly\n` +
            `# this url's hostname, on the next container start or init-firewall.sh run.\n\n`;
        await writeFile(path, header + stringifyYaml(target), 'utf8');
        return ok(path);
    } catch (thrown: unknown) {
        return err(scoutError('config', `cannot write target ${target.id}: ${messageOf(thrown)}`, { cause: thrown }));
    }
}

// --- Recipes ------------------------------------------------------------------------

export async function loadRecipe(recipesDir: string, id: string): Promise<Result<Recipe, ScoutError>> {
    const path = join(recipesDir, `${id}.recipe.yaml`);
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch {
        // Absence is an ordinary state, not a failure: it simply means this target has
        // never been generated. The caller's response is to generate, not to alarm.
        return err(scoutError('empty-extraction', `no recipe yet for ${id}`));
    }

    let doc: unknown;
    try {
        doc = parseYaml(raw);
    } catch (thrown: unknown) {
        return err(scoutError('config', `${path} is not valid YAML: ${messageOf(thrown)}`, { cause: thrown }));
    }

    const parsed = RecipeSchema.safeParse(doc);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return err(scoutError('config', `${path} is not a valid recipe: ${detail}`));
    }
    return ok(parsed.data);
}

export async function saveRecipe(
    recipesDir: string,
    id: string,
    recipe: Recipe,
): Promise<Result<string, ScoutError>> {
    const path = join(recipesDir, `${id}.recipe.yaml`);
    try {
        await mkdir(recipesDir, { recursive: true });
        const header =
            `# GENERATED FILE — written by Scout's recipe generator, and overwritten whenever\n` +
            `# extraction goes stale and self-heals. Hand edits will be lost.\n` +
            `#\n` +
            `# Committed deliberately: when a site redesigns, the diff here is the evidence of\n` +
            `# what changed. To adjust WHAT is matched rather than HOW, edit targets/${id}.yaml.\n` +
            `#\n` +
            `# model: ${recipe.generatedBy}   generated: ${recipe.generatedAt}\n\n`;
        await writeFile(path, header + stringifyYaml(recipe), 'utf8');
        return ok(path);
    } catch (thrown: unknown) {
        return err(scoutError('config', `cannot write recipe ${id}: ${messageOf(thrown)}`, { cause: thrown }));
    }
}
