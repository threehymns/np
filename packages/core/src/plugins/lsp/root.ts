/**
 * Project-root scoping (spec #263, ADR 0019).
 *
 * The ordered marker list belongs to the descriptor; the walk belongs here. The
 * descriptor says *what identifies a project* (a `tsconfig.json` says more about
 * a TypeScript file than a `package.json` does, so the order is data), and this
 * module says *how to use it*: from the open document's own directory upward,
 * within a directory the first declared marker present wins, and across
 * directories the marker declared first wins overall, ties broken by the nearest
 * directory.
 *
 * The consequence worth stating: a nearer marker does not beat a more specific
 * one. In a repository with a root `tsconfig.json` and a `package.json` in a
 * nested package, a file in that package still resolves to the root the
 * `tsconfig.json` declares, which is the project a TypeScript server wants.
 * That is what "the order selects the root" buys, and it is why `rootMarkers` is
 * a list and not a set.
 *
 * No `node:path` and no filesystem access: the walk is string work, and the one
 * question it needs answered — does this marker exist — arrives through the
 * transport seam, so the resolution is testable with a probe and no disk.
 */

export interface RootProbe {
	fileExists(path: string): Promise<boolean>;
}

export interface ProjectRootResult {
	/** The directory the server is scoped to. */
	readonly root: string;
	/** The marker that decided it, or null when the document's own directory was used. */
	readonly marker: string | null;
	/** True when no marker was found and the document's own directory is the root. */
	readonly usedFallback: boolean;
}

const separatorPattern = /[\\/]/;

function lastSeparatorIndex(path: string): number {
	let index = -1;
	for (let i = 0; i < path.length; i++) {
		if (separatorPattern.test(path[i])) index = i;
	}
	return index;
}

/** Directory containing `path`. No trailing separator, `/` when there is none. */
export function dirnameOf(path: string): string {
	const index = lastSeparatorIndex(path);
	if (index < 0) return path;
	if (index === 0) return path.slice(0, 1);
	// A Windows drive root (`C:\`) must keep its separator: `C:` alone is the
	// current directory on that drive, not the root.
	if (index === 2 && /^[A-Za-z]:[\\/]$/.test(path.slice(0, 3))) return path.slice(0, 3);
	return path.slice(0, index);
}

function joinPath(directory: string, name: string): string {
	if (directory.endsWith('/') || directory.endsWith('\\')) return `${directory}${name}`;
	return `${directory}/${name}`;
}

/** Every directory from `startDir` up to and including `boundary`, nearest first. */
function ancestorDirectories(startDir: string, boundary: string | null): string[] {
	const directories: string[] = [];
	let current = startDir;
	for (;;) {
		directories.push(current);
		const parent = dirnameOf(current);
		if (parent === current) break;
		if (boundary !== null && parent.length < boundary.length) break;
		current = parent;
	}
	return directories;
}

export interface FindProjectRootOptions {
	readonly startDir: string;
	readonly markers: readonly string[];
	readonly probe: RootProbe;
	/**
	 * Highest directory worth walking to, normally the workspace root. Beyond it
	 * a marker belongs to some other project, so the walk stops. Null walks to
	 * the filesystem root, which is what a document outside any folder gets.
	 */
	readonly boundary?: string | null;
}

export async function findProjectRoot(options: FindProjectRootOptions): Promise<ProjectRootResult> {
	const boundary = options.boundary ?? null;
	let best: { root: string; marker: string; markerIndex: number } | null = null;

	// Nearest directory first, and a strictly-better marker index is the only
	// thing that replaces a hit, so the nearest of two equal markers wins.
	for (const directory of ancestorDirectories(options.startDir, boundary)) {
		for (const [markerIndex, marker] of options.markers.entries()) {
			if (!(await options.probe.fileExists(joinPath(directory, marker)))) continue;
			if (best === null || markerIndex < best.markerIndex) {
				best = { root: directory, marker, markerIndex };
			}
			break;
		}
	}

	if (best !== null) {
		return { root: best.root, marker: best.marker, usedFallback: false };
	}
	return { root: options.startDir, marker: null, usedFallback: true };
}

/**
 * File URI for a path, as the protocol addresses documents. Percent-encodes
 * each segment so a path with a space or a `#` survives the round trip.
 */
export function toFileUri(path: string): string {
	const normalized = path.replace(/\\/g, '/');
	const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
	return `file://${prefixed
		.split('/')
		.map((segment, index) =>
			// A Windows drive keeps its colon: `file:///C:/x` is the form servers
			// resolve, and escaping it produces a path nothing can open.
			index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)
		)
		.join('/')}`;
}
