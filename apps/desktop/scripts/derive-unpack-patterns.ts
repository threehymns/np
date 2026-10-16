import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LSP_DESCRIPTORS } from '../../../packages/core/src/plugins/lsp/descriptors';
import { deriveAsarUnpackPatterns } from '../src/lsp-packaging';

/**
 * Regenerates or checks apps/desktop/package.json build.asarUnpack against the
 * installed dependency closures of the bundled descriptors.
 */
const packageJsonPath = path.resolve(import.meta.dir, '..', 'package.json');
const raw = readFileSync(packageJsonPath, 'utf-8');
const manifest = JSON.parse(raw) as {
	build: { asarUnpack?: string[] };
	[key: string]: unknown;
};

const derivedPatterns = deriveAsarUnpackPatterns(LSP_DESCRIPTORS, path.dirname(packageJsonPath));
const currentPatterns = manifest.build.asarUnpack ?? [];

const matches =
	currentPatterns.length === derivedPatterns.length &&
	currentPatterns.every((pattern, index) => pattern === derivedPatterns[index]);

if (process.argv.includes('--check')) {
	if (!matches) {
		console.error(
			'apps/desktop/package.json build.asarUnpack does not match derived patterns from descriptors.\n' +
				'Action: Run `bun run scripts/derive-unpack-patterns.ts` to regenerate.'
		);
		process.exit(1);
	}
	process.exit(0);
}

if (!matches) {
	manifest.build.asarUnpack = derivedPatterns;
	writeFileSync(packageJsonPath, JSON.stringify(manifest, null, '\t') + '\n', 'utf-8');
	console.log(`Updated apps/desktop/package.json build.asarUnpack with ${derivedPatterns.length} patterns.`);
} else {
	console.log('apps/desktop/package.json build.asarUnpack is up to date.');
}
