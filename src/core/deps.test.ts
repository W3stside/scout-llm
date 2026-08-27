/**
 * Every imported package must be a DECLARED dependency.
 *
 * tsc cannot catch this. It resolves against node_modules, so a package installed but never
 * written into package.json typechecks perfectly on the machine that installed it and fails
 * only on a clean install — which in practice means the container build, after the native
 * modules have already compiled and several minutes have already been spent.
 *
 * That is exactly how @grammyjs/conversations shipped: present on disk, absent from
 * package.json and yarn.lock, green locally, `TS2307: Cannot find module` in Docker.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ROOT = join(SRC, '..');

function _sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            out.push(..._sourceFiles(path));
        } else if (entry.endsWith('.ts')) {
            out.push(path);
        }
    }
    return out;
}

/** Bare specifiers only — relative paths and node: builtins are not packages. */
function _importedPackages(source: string): string[] {
    const specifiers: string[] = [];
    // `[^;\`]` is load-bearing: without it the gap can scan past the end of a statement and
    // into a template literal, and this file's own SQL — `... "scored below threshold" from
    // "never scored"` — was duly reported as a missing package called "never scored".
    // Barring semicolons and backticks keeps a match inside one real import statement.
    const pattern = /(?:^|\n)\s*(?:import|export)\s[^;`]*?\bfrom\s+['"]([^'"]+)['"]/g;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
        const specifier = match[1];
        if (specifier === undefined) {
            continue;
        }
        if (specifier.startsWith('.') || specifier.startsWith('node:')) {
            continue;
        }
        // Scoped packages keep two segments (@grammyjs/conversations); the rest keep one,
        // so a deep import like "cheerio/lib/x" still maps back to "cheerio".
        const parts = specifier.split('/');
        specifiers.push(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier));
    }
    return specifiers;
}

describe('declared dependencies', () => {
    it('covers every package imported from src/', () => {
        const manifest: unknown = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
        expect(typeof manifest).toBe('object');
        const pkg = manifest as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };

        const declared = new Set([
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.devDependencies ?? {}),
            // Transitive but imported directly for its types: cheerio re-exports the DOM
            // node types from domhandler, and naming it here is honest about the coupling.
            'domhandler',
        ]);

        const missing = new Map<string, string[]>();
        for (const file of _sourceFiles(SRC)) {
            for (const pkgName of _importedPackages(readFileSync(file, 'utf8'))) {
                if (!declared.has(pkgName)) {
                    const where = missing.get(pkgName) ?? [];
                    where.push(file.replace(`${ROOT}/`, ''));
                    missing.set(pkgName, where);
                }
            }
        }

        const report = [...missing].map(([name, files]) => `${name} (imported by ${files.join(', ')})`);
        expect(report, 'undeclared imports would break a clean install').toEqual([]);
    });

    it('locks every runtime dependency', () => {
        // A dependency in package.json but absent from yarn.lock fails
        // `yarn install --frozen-lockfile`, which is what the container build runs.
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
        };
        const lock = readFileSync(join(ROOT, 'yarn.lock'), 'utf8');

        const unlocked = Object.keys(pkg.dependencies ?? {}).filter((name) => !lock.includes(`${name}@`));
        expect(unlocked, 'run yarn install to refresh yarn.lock').toEqual([]);
    });
});
