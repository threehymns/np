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
 * platform seam, so the resolution is testable with a probe and no disk. The
 * dependency is named for the question rather than for the platform that answers
 * it, which is why a caller passes one method rather than the whole seam.
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

/**
 * Whether `directory` is `boundary` or sits under it.
 *
 * Containment, not length. A length compare asks "is this path shorter than the
 * boundary", which every sibling directory of the boundary answers yes to — so a
 * file in `/work/other` would walk up through `/work` and adopt its
 * `tsconfig.json` on the strength of being the same width as the workspace root.
 * The separator check is what stops a prefix match: `/work` does not contain
 * `/workspace`, and `/repo/app` does not contain `/repo/application`.
 */
function isWithin(directory: string, boundary: string): boolean {
	// A boundary of `/` normalises away to nothing, which is the one case where
	// every directory is contained: the walk may climb to the filesystem root.
	const normalized = boundary.replace(/[\\/]+$/, '');
	if (normalized === '') return true;
	if (directory === normalized) return true;
	return (
		directory.startsWith(normalized) &&
		separatorPattern.test(directory.charAt(normalized.length))
	);
}

/** Every directory from `startDir` up to and including `boundary`, nearest first. */
function ancestorDirectories(startDir: string, boundary: string | null): string[] {
	const directories: string[] = [];
	let current = startDir;
	for (;;) {
		directories.push(current);
		const parent = dirnameOf(current);
		if (parent === current) break;
		// Stop when the next step would leave the boundary — which is also the
		// answer for a document that is not under it at all: its own directory is
		// the only one that gets looked at.
		if (boundary !== null && !isWithin(parent, boundary)) break;
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
	 *
	 * Containment, not a width: a document that is not under the boundary at all
	 * is scoped to its own directory rather than walking up through directories
	 * that merely have shorter paths.
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

/**
 * The path a `file://` URI addresses, or null when it addresses something else.
 *
 * The inverse of {@link toFileUri}, needed wherever a URI arrives from the server
 * and a local decision has to be made about it — which language a diagnostics
 * report is about, for one. A server is entitled to address a document with a
 * scheme this client cannot resolve, and such a URI is not a path, so it is
 * rejected rather than mangled into `://…`.
 */
export function fromFileUri(uri: string): string | null {
	if (!uri.startsWith('file://')) return null;
	const path = uri.slice('file://'.length);
	if (path.length === 0) return null;
	return decodeURIComponent(path);
}

/** The last path segment of a URI, which is the name a language is matched on. */
export function basenameOfUri(uri: string): string {
	const path = fromFileUri(uri) ?? uri;
	const lastSlash = path.lastIndexOf('/');
	return lastSlash < 0 ? path : path.slice(lastSlash + 1);
}
