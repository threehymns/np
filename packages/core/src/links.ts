import type { Workspace } from './workspace.svelte';
import type { DocumentSession } from './document.svelte';
import type { FileOrigin, Storage } from './storage';

export type { Workspace, DocumentSession };

export interface InternalLinkTarget {
	raw: string;
	path: string;
	subpath: {
		type: 'heading' | 'block';
		value: string;
	} | null;
	alias: string | null;
	isEmbed: boolean;
}

/**
 * Parses an Obsidian-style internal link.
 * Supports:
 * - [[Note]]
 * - [[Note.md]]
 * - [[Folder/Note]]
 * - [[#Heading]]
 * - [[Note#Heading]]
 * - [[Note#Subheading 1#Subheading 2]]
 * - [[#^block-id]]
 * - [[^block-id]]
 * - [[Note#^block-id]]
 * - [[Note|Display Text]]
 * - [[Note#Heading|Display Text]]
 * - ![[Embed Note]]
 * - ![[Image.png|Caption]]
 * - Standard markdown destinations e.g. [display](target.md#heading) or raw target string
 */
export function parseInternalLink(rawLink: string): InternalLinkTarget {
	let str = rawLink.trim();
	let isEmbed = false;

	if (str.startsWith('!')) {
		isEmbed = true;
		str = str.slice(1).trim();
	}

	if (str.startsWith('[[') && str.endsWith(']]')) {
		str = str.slice(2, -2).trim();
	}

	// Extract display text / alias (pipe syntax)
	let alias: string | null = null;
	const pipeIndex = str.indexOf('|');
	if (pipeIndex !== -1) {
		alias = str.slice(pipeIndex + 1).trim();
		str = str.slice(0, pipeIndex).trim();
	}

	// Markdown destination URL decoding if encoded
	if (str.includes('%')) {
		try {
			str = decodeURIComponent(str);
		} catch {
			// ignore decoding errors
		}
	}

	// Bare block reference: `[[^block-id]]`, the spelling the editor's own block
	// completion produces (the user types `[[^`, then picks an id, so the applied
	// text is just the id). There is no `#` here, so the hash-split below never
	// runs and the whole thing would otherwise be treated as the *name of a file*.
	// Left unhandled, `openInternalLink` takes the "target is in a note" branch
	// with allowCreate defaulting to true, so following the link silently creates
	// a junk note named `^block-id.md` instead of scrolling to the block.
	//
	// The "no `#`" part is load-bearing and not just descriptive: `[[^alpha#…]]`
	// does have one, so it belongs to the hash-split like every other link.
	// Folding the whole string into a single block id made the id "alpha#…",
	// which no block can have (ids are [a-zA-Z0-9-]), so the link resolved to
	// nothing. The shortcut only applies to the hash-free spelling above.
	if (str.startsWith('^') && !str.includes('#')) {
		return {
			raw: rawLink,
			path: '',
			subpath: {
				type: 'block',
				value: str.slice(1).trim(),
			},
			alias,
			isEmbed,
		};
	}

	// Heading or Block subpath syntax
	const hashIndex = str.indexOf('#');
	if (hashIndex !== -1) {
		const pathPart = str.slice(0, hashIndex).trim();
		const afterHash = str.slice(hashIndex + 1).trim();

		// Block subpath: starts with ^ or contains #^
		if (afterHash.startsWith('^')) {
			return {
				raw: rawLink,
				path: pathPart,
				subpath: {
					type: 'block',
					value: afterHash.slice(1).trim(),
				},
				alias,
				isEmbed,
			};
		}

		// Heading subpath (can be multi-level: Section 2#Sub-item A)
		let headingPart = afterHash;
		const blockMatch = afterHash.match(/#\^([a-zA-Z0-9-]+)$/);
		if (blockMatch) {
			return {
				raw: rawLink,
				path: pathPart,
				subpath: {
					type: 'block',
					value: blockMatch[1],
				},
				alias,
				isEmbed,
			};
		}

		return {
			raw: rawLink,
			path: pathPart,
			subpath: {
				type: 'heading',
				value: headingPart,
			},
			alias,
			isEmbed,
		};
	}

	return {
		raw: rawLink,
		path: str.trim(),
		subpath: null,
		alias,
		isEmbed,
	};
}

export interface EmbedSize {
	width: number;
	height: number | null;
}

export interface ResizeTokenResult {
	base: string;
	size: EmbedSize | null;
}

const SIZE_TOKEN_RE = /^(\d+)(?:x(\d+))?$/;

/**
 * Validates a bare resize token (`300`, `400`, `300x200`).
 * Returns the parsed size, or null when the token is missing/invalid.
 * Pure function over text — no I/O, no Editor, no Storage.
 */
export function parseSizeToken(token: string): EmbedSize | null {
	const t = token.trim();
	const m = t.match(SIZE_TOKEN_RE);
	if (!m) return null;
	const width = Number.parseInt(m[1], 10);
	const height = m[2] !== undefined ? Number.parseInt(m[2], 10) : null;
	if (!Number.isSafeInteger(width) || width <= 0) return null;
	if (height !== null && (!Number.isSafeInteger(height) || height <= 0))
		return null;
	return { width, height };
}

/**
 * Extracts an Obsidian resize token from embed target text.
 *
 * Shared by both embed syntaxes — pass the wikilink-embed inner text
 * (`photo.png|300`) or the Markdown-image label (`alt|400`); the Markdown
 * destination (`photo.png`) is separate and needs no parsing.
 *
 * Splits on the first `|` (same rule as `parseInternalLink`); a numeric
 * suffix parses as a size, anything else (notably `[[Note|Custom Text]]`
 * aliases) yields `size: null` with `base` left intact. Pure function over
 * text — no I/O, no Editor, no Storage.
 */
export function parseResizeToken(target: string): ResizeTokenResult {
	const raw = target.trim();
	const pipeIndex = raw.indexOf('|');
	if (pipeIndex === -1) {
		return { base: raw, size: null };
	}
	const size = parseSizeToken(raw.slice(pipeIndex + 1).trim());
	if (!size) {
		return { base: raw, size: null };
	}
	return { base: raw.slice(0, pipeIndex).trim(), size };
}

export interface HeadingItem {
	text: string;
	level: number;
	line: number; // 1-indexed
}

/**
 * Can this trimmed line carry a Setext heading underline under it?
 *
 * A Setext underline turns the line above it into a heading only when that line
 * is paragraph text. Anything that opens another block — a list, a blockquote,
 * an HTML block, an indented code block, or a thematic break of its own — is not
 * paragraph text, and a `---` after it is a thematic break, not an underline.
 *
 * The indented-code case is why this takes the trimmed line: four or more
 * leading spaces in the ORIGINAL line mean a code block, so the caller passes a
 * line whose indentation has been measured, not simply stripped.
 */
function isParagraphText(trimmed: string, originalLine?: string): boolean {
	if (trimmed.length === 0) return false;
	// 4+ spaces of original indentation is an indented code block.
	if (originalLine !== undefined && /^(?: {4}|\t)/.test(originalLine)) return false;
	// List item (bullet, ordered, or task) and blockquote.
	if (/^(?:[-*+]|\d{1,9}[.)])\s/.test(trimmed)) return false;
	if (trimmed.startsWith('>')) return false;
	// Thematic break: `---`, `***`, `___`. Only the first can precede an
	// underline, but all three start a new block, so none is paragraph text.
	if (/^(?:[*-]\s*){3,}$/.test(trimmed)) return false;
	// HTML block.
	if (trimmed.startsWith('<')) return false;
	return true;
}

/**
 * Tracks fenced code blocks across the lines of a document.
 *
 * A boolean "am I inside a code block" flag is not enough: a closing fence must
 * match the opener, so the tracker has to remember the character and the length
 * of the fence currently open.
 *
 * The rules implemented here are CommonMark's:
 *  - A fence is three or more backticks, or three or more tildes.
 *  - A closing fence uses the SAME character as its opener, is at least as long,
 *    and carries no info string.
 *  - A backtick fence's info string may not contain a backtick, so "```a`b" opens
 *    nothing at all.
 *  - A fence left open at the end of the document stays open.
 */
class FenceTracker {
	/** The fence character currently open, or null when not in a code block. */
	private char: string | null = null;
	/** How many of that character the opener used; a closer may not be shorter. */
	private length = 0;

	/**
	 * Feeds one trimmed line. Returns true when the line is a fence delimiter or
	 * code-block content, so callers should skip their own parsing for it.
	 */
	skip(line: string): boolean {
		if (this.char === null) {
			return this.tryOpen(line);
		}
		if (this.closes(line)) {
			this.char = null;
			this.length = 0;
		}
		return true; // the opener, the closer, or code content
	}

	private tryOpen(line: string): boolean {
		const backticks = /^`{3,}/.exec(line);
		if (backticks) {
			// A backtick info string containing a backtick is not a fence.
			if (line.slice(backticks[0].length).includes('`')) return false;
			this.char = '`';
			this.length = backticks[0].length;
			return true;
		}
		const tildes = /^~{3,}/.exec(line);
		if (tildes) {
			this.char = '~';
			this.length = tildes[0].length;
			return true;
		}
		return false;
	}

	private closes(line: string): boolean {
		const char = this.char === '~' ? '~' : '`';
		return new RegExp(`^${char}{${this.length},}\\s*$`).test(line);
	}
}

/**
 * Extracts all ATX and Setext headings from markdown content.
 */
export function getHeadings(content: string): HeadingItem[] {
	const lines = content.split(/\r?\n/);
	const headings: HeadingItem[] = [];

	const fence = new FenceTracker();

	// Skip YAML frontmatter: a leading `---` block whose keys would otherwise
	// be misread as Setext H2 underlines (e.g. `tags: [a]` followed by `---`).
	let startIndex = 0;
	if (lines.length > 0 && lines[0].trim() === '---') {
		for (let j = 1; j < lines.length; j++) {
			const marker = lines[j].trim();
			if (marker === '---' || marker === '...') {
				startIndex = j + 1;
				break;
			}
		}
	}

	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Fences and their contents are never headings or Setext underlines.
		if (fence.skip(trimmed)) continue;

		// 1. ATX headings (# Heading)
		//    Up to three leading spaces are allowed. Four or more make an indented
		//    code block instead, which this anchor enforces by not matching.
		//    Indentation is common in practice, e.g. a heading under a list item,
		//    and the editor renders those as headings.
		const atxMatch = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?$/);
		if (atxMatch) {
			const level = atxMatch[1].length;
			const text = atxMatch[2].trim();
			headings.push({
				text,
				level,
				line: i + 1,
			});
			continue;
		}

		// 2. Setext headings (Line followed by === or ---)
		//    Reaching here means this line is not inside a code block, and a run
		//    of '=' or '-' can never be a fence, so the underline is ordinary text.
		//    The line above the underline must be paragraph TEXT: a list item, a
		//    blockquote, an HTML block, or an indented code line is followed by a
		//    thematic break, not a heading, and the editor does not render it as one.
		if (i + 1 < lines.length && isParagraphText(trimmed, line)) {
			const nextLine = lines[i + 1].trim();
			if (/^[=-]{3,}$/.test(nextLine)) {
				const isH1 = nextLine.startsWith('=');
				headings.push({
					text: trimmed,
					level: isH1 ? 1 : 2,
					line: i + 1,
				});
				i++; // Skip underline
				continue;
			}
		}
	}

	return headings;
}

/**
 * Finds the 1-indexed line number of a heading matching `headingPath`.
 * Supports nested subheadings like `Heading 1#Subheading 2`.
 *
 * Each path segment must match a heading nested strictly *under* the one the
 * previous segment matched. Matching on document order alone was not enough:
 * a sibling pair like `Two#Three` and a parent/child pair spelled backwards
 * like `Shared#Gamma` both resolved to a line the caller never named, so a
 * link would scroll the user somewhere unrelated.
 */
export function findHeadingLine(content: string, headingPath: string): number | null {
	const headings = getHeadings(content);

	// A heading's own text may contain '#' (or '|', though the parser has already
	// split that off as an alias), so try the WHOLE path as one literal name
	// before splitting. Without this, a heading the completion itself offers —
	// it reports heading text verbatim — can never be reached: `C#` splits into
	// ["c", ""] and no heading is named "". The link is a real, clickable
	// WikiLink, so the user picks a listed target and following it scrolls
	// nowhere.
	const whole = headingPath.trim().toLowerCase();
	if (whole) {
		const exact = headings.find((h) => h.text.trim().toLowerCase() === whole);
		if (exact) return exact.line;
	}

	const segments = headingPath
		.split('#')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

	if (segments.length === 0) return null;

	if (segments.length === 1) {
		const target = segments[0];
		const match = headings.find(
			(h) => h.text.trim().toLowerCase() === target
		);
		return match ? match.line : null;
	}

	// Multi-segment heading path. A segment may only match a heading deeper than
	// the previous match, so a heading of the same or shallower level ends the
	// candidate chain rather than continuing it.
	let currentIndex = 0;
	let previousLevel = 0;
	for (const heading of headings) {
		const hText = heading.text.trim().toLowerCase();
		// Headings at or above the last match's level are not inside it, so this
		// branch is abandoned and the search restarts from later segments.
		if (heading.level <= previousLevel) {
			currentIndex = 0;
			previousLevel = 0;
		}
		if (hText === segments[currentIndex]) {
			previousLevel = heading.level;
			currentIndex++;
			if (currentIndex === segments.length) {
				return heading.line;
			}
		}
	}

	return null;
}

export interface BlockItem {
	id: string;
	preview: string;
	line: number; // 1-indexed
}

/**
 * Extracts all block identifiers (`^id`) from markdown content.
 */
export function getBlocks(content: string): BlockItem[] {
	const lines = content.split(/\r?\n/);
	const blocks: BlockItem[] = [];

	// Same CommonMark fence rules as getHeadings, so a code sample cannot hand
	// out a block reference the rest of the app would treat as real.
	const fence = new FenceTracker();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		if (fence.skip(trimmed)) continue;

		// Block reference: ^([a-zA-Z0-9-]+) at end of block or line.
		// Trailing whitespace after the id is tolerated: it is invisible in the
		// editor and is what a formatter, a copy-paste, or a stray keystroke
		// leaves behind. Without this, one trailing space silently made the id
		// stop resolving while the note rendered perfectly. The id must still be
		// the last thing on the line -- whitespace is skipped, content is not.
		const match = line.match(/\^([a-zA-Z0-9-]+)[ \t]*$/);
		if (match) {
			const id = match[1];
			// Preview is line content without the marker
			const preview = line.replace(/\^([a-zA-Z0-9-]+)[ \t]*$/, '').trim();
			blocks.push({
				id,
				preview: preview || id,
				line: i + 1,
			});
		}
	}

	return blocks;
}

/**
 * Finds the 1-indexed line number of a block matching `blockId`.
 */
export function findBlockLine(content: string, blockId: string): number | null {
	const blocks = getBlocks(content);
	const target = blockId.trim().toLowerCase();
	const match = blocks.find((b) => b.id.toLowerCase() === target);
	return match ? match.line : null;
}

/**
 * Recursively searches storage for a file named targetName or targetWithExt.
 */
export async function searchVaultForFile(
	storage: Storage,
	dirOrigin: FileOrigin,
	targetName: string,
	targetWithExt: string
): Promise<FileOrigin | null> {
	try {
		const entries = await storage.readDirectory(dirOrigin);
		for (const entry of entries) {
			// Skip hidden or .git directories
			if (entry.name.startsWith('.git')) {
				continue;
			}
			if (entry.name.startsWith('.') && entry.name !== '.gitignore') {
				continue;
			}

			if (entry.kind === 'file') {
				const lowerName = entry.name.toLowerCase();
				if (
					lowerName === targetWithExt.toLowerCase() ||
					lowerName === targetName.toLowerCase()
				) {
					return entry.origin;
				}
			} else if (entry.kind === 'directory') {
				const found = await searchVaultForFile(
					storage,
					entry.origin,
					targetName,
					targetWithExt
				);
				if (found) return found;
			}
		}
	} catch {
		// Ignore read directory errors
	}
	return null;
}

/**
 * Resolves the destination FileOrigin for an internal note link in a workspace.
 *
 * The exact target is tried first so explicit paths (e.g. `Figure 1.png`)
 * and dotted note names (e.g. `Chapter 1.2`) resolve before the `.md`
 * fallback is applied. Pass `{ allowCreate: false }` for embeds so an
 * unresolved embed never creates a file.
 */
export async function resolveTargetOrigin(
	workspace: Workspace,
	currentDoc: DocumentSession | null,
	targetPath: string,
	options: { allowCreate?: boolean } = {}
): Promise<FileOrigin | null> {
	if (!targetPath) {
		return currentDoc?.origin ?? null;
	}

	const normalizedTarget = targetPath.replace(/\\/g, '/');
	const hasMdExtension = /\.md$/i.test(normalizedTarget);
	const candidates = hasMdExtension
		? [normalizedTarget]
		: [normalizedTarget, `${normalizedTarget}.md`];

	if (workspace.rootOrigin) {
		const rootPath = workspace.rootOrigin.path.replace(/\/$/, '');
		const scheme = workspace.rootOrigin.scheme;

		for (const candidate of candidates) {
			const candidateName = candidate.split('/').pop()!;
			const stripped = candidate.replace(/^\//, '');

			// 1. Direct path relative to workspace root
			const directRootOrigin: FileOrigin = {
				scheme,
				path: `${rootPath}/${stripped}`,
				name: candidateName,
			};
			try {
				await workspace.storage.readFile(directRootOrigin);
				return directRootOrigin;
			} catch {
				// Not found directly at root
			}

			// 2. Path relative to current note directory
			if (currentDoc?.origin) {
				const currentDocPath = currentDoc.origin.path;
				const lastSlash = currentDocPath.lastIndexOf('/');
				if (lastSlash !== -1) {
					const currentDir = currentDocPath.slice(0, lastSlash);
					const relOrigin: FileOrigin = {
						scheme,
						path: `${currentDir}/${stripped}`,
						name: candidateName,
					};
					try {
						await workspace.storage.readFile(relOrigin);
						return relOrigin;
					} catch {
						// Not found relative to current file
					}
				}
			}

			// 3. Vault-wide search
			const vaultFound = await searchVaultForFile(
				workspace.storage,
				workspace.rootOrigin,
				candidateName,
				candidate
			);
			if (vaultFound) {
				return vaultFound;
			}
		}

		// 4. Note does not exist yet. Obsidian rule: create note at the link's folder path.
		// Unresolved embeds must not create files (e.g. ![[missing.png]]).
		if (options.allowCreate === false) {
			return null;
		}

		// Preserve explicit asset paths (e.g. `Figure 1.png`). A trailing
		// dot-segment without letters (e.g. `Chapter 1.2`) is a version
		// number, not an extension, so it still gets `.md`.
		const hasExplicitExtension =
			/\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/.test(normalizedTarget);
		const createTarget =
			hasMdExtension || hasExplicitExtension
				? normalizedTarget
				: `${normalizedTarget}.md`;
		const newPath = normalizePosixPath(
			`${rootPath}/${createTarget.replace(/^\//, '')}`
		);
		// Reject traversal outside the vault (e.g. [[../outside]]) before creating.
		if (!isWithinPath(newPath, rootPath)) {
			return null;
		}
		const newOrigin: FileOrigin = {
			scheme,
			path: newPath,
			name: newPath.split('/').pop()!,
		};
		// Create empty file
		await workspace.storage.saveFile('', newOrigin);
		return newOrigin;
	}

	return null;
}

/**
 * Normalizes a POSIX-style vault path, resolving `.` and `..` segments.
 */
function normalizePosixPath(path: string): string {
	const isAbsolute = path.startsWith('/');
	const stack: string[] = [];
	for (const part of path.split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (stack.length > 0 && stack[stack.length - 1] !== '..') {
				stack.pop();
			} else if (!isAbsolute) {
				stack.push('..');
			}
		} else {
			stack.push(part);
		}
	}
	return (isAbsolute ? '/' : '') + stack.join('/');
}

/**
 * Checks that a normalized candidate path stays beneath the vault root.
 */
function isWithinPath(candidatePath: string, rootPath: string): boolean {
	const root = rootPath.replace(/\/$/, '') || '/';
	return candidatePath === root || candidatePath.startsWith(`${root}/`);
}

/**
 * Resolves an internal link target and opens it in the workspace.
 * Sets pendingLineToScroll on the document session if heading or block is present.
 */
export async function openInternalLink(
	workspace: Workspace,
	currentDoc: DocumentSession | null,
	rawLink: string,
	options: { allowCreate?: boolean } = {}
): Promise<DocumentSession | null> {
	const parsed = parseInternalLink(rawLink);

	let targetDoc: DocumentSession | null = null;

	if (!parsed.path) {
		// Same-note anchor link (e.g. [[#Heading]] or [[#^block-id]])
		targetDoc = currentDoc;
	} else {
		// Target is in a note
		const allowCreate = options.allowCreate !== undefined ? options.allowCreate : !parsed.isEmbed;
		const targetOrigin = await resolveTargetOrigin(
			workspace,
			currentDoc,
			parsed.path,
			{ allowCreate }
		);

		if (targetOrigin) {
			const opened = await workspace.openFile(targetOrigin);
			targetDoc = opened ?? null;
		} else if (!workspace.rootOrigin) {
			// No folder open, check open documents
			const existing = workspace.documents.find(
				(d) =>
					d.fileName.toLowerCase() === parsed.path.toLowerCase() ||
					d.fileName.toLowerCase() === `${parsed.path.toLowerCase()}.md` ||
					d.untitledTitle.toLowerCase() === parsed.path.toLowerCase()
			);
			if (existing) {
				workspace.activeDocumentId = existing.id;
				targetDoc = existing;
			} else if (allowCreate) {
				// Create new untitled note with the target name
				const newDoc = await workspace.newFile();
				newDoc.untitledTitle = parsed.path.endsWith('.md')
					? parsed.path
					: `${parsed.path}.md`;
				targetDoc = newDoc;
			}
		}
	}

	if (!targetDoc) return null;

	if (!targetDoc.isLoaded) {
		await targetDoc.loadContent();
	}

	// Handle anchor (heading or block)
	if (parsed.subpath) {
		let lineNum: number | null = null;
		if (parsed.subpath.type === 'heading') {
			lineNum = findHeadingLine(targetDoc.content, parsed.subpath.value);
		} else if (parsed.subpath.type === 'block') {
			lineNum = findBlockLine(targetDoc.content, parsed.subpath.value);
		}

		if (lineNum !== null) {
			targetDoc.pendingLineToScroll = lineNum;
		}
	}

	return targetDoc;
}

export interface TreeNodeLike {
	kind: string;
	name: string;
	origin: FileOrigin;
	children?: TreeNodeLike[];
}

/**
 * Recursively collects all file nodes from a project tree.
 */
export function getAllFilesFromTree(nodes: TreeNodeLike[] = []): TreeNodeLike[] {
	const files: TreeNodeLike[] = [];
	function walk(items: TreeNodeLike[]) {
		for (const item of items) {
			if (item.kind === 'file') {
				files.push(item);
			} else if (item.kind === 'directory' && item.children) {
				walk(item.children);
			}
		}
	}
	walk(nodes);
	return files;
}
