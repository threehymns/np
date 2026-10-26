import { rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Removes build output that the compiler does not clean up on its own.
 * `tsc` leaves stale files in `dist-main` when a source file is renamed or
 * deleted, so a production build must start from an empty directory.
 *
 * The renderer output (`dist`) is emptied by Vite, and installers in
 * `dist-electron` are intentionally kept across builds.
 */
const desktopRoot = path.resolve(import.meta.dir, '..');
rmSync(path.join(desktopRoot, 'dist-main'), { recursive: true, force: true });
