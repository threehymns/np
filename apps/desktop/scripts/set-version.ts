import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Writes the release tag's version into the desktop manifest before packaging.
 * electron-builder reads the app version from package.json, so the tag (not a
 * hand-edited manifest) is the source of truth for release builds.
 *
 * Usage: RELEASE_TAG=v1.2.3 bun run set-version
 *        bun run set-version v1.2.3
 */
const rawTag = process.env.RELEASE_TAG ?? process.argv[2];

if (!rawTag) {
	console.error('Missing release tag. Pass it as an argument or set RELEASE_TAG.');
	process.exit(1);
}

if (!rawTag.startsWith('v')) {
	console.error(`Release tag "${rawTag}" must start with "v" (for example v1.2.3).`);
	process.exit(1);
}

const version = rawTag.slice(1);
if (!SEMVER.test(version)) {
	console.error(`Release tag "${rawTag}" is not a valid semantic version.`);
	process.exit(1);
}

const packageJsonPath = path.resolve(import.meta.dir, '..', 'package.json');
const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
	version: string;
	[key: string]: unknown;
};

manifest.version = version;
writeFileSync(packageJsonPath, JSON.stringify(manifest, null, '\t') + '\n', 'utf-8');
console.log(`Set apps/desktop/package.json version to ${version}.`);
