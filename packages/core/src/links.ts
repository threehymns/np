import type { Workspace, DocumentSession } from './workspace.svelte';
import type { FileOrigin, Storage } from './storage';

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

	// Check for block reference (#^block-id)
	const blockMatch = str.match(/#\^([a-zA-Z0-9-]+)$/);
	if (blockMatch) {
		const blockId = blockMatch[1];
		const pathPart = str.slice(0, blockMatch.index).trim();
		return {
			raw: rawLink,
			path: pathPart,
			subpath: {
				type: 'block',
				value: blockId,
			},
			alias,
			isEmbed,
		};
	}

	// Check for heading link (#Heading or #Heading#Subheading)
	const firstHashIndex = str.indexOf('#');
	if (firstHashIndex !== -1) {
		const pathPart = str.slice(0, firstHashIndex).trim();
		const headingPart = str.slice(firstHashIndex + 1).trim();
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

export interface HeadingItem {
	text: string;
	level: number;
	line: number; // 1-indexed
}

/**
 * Extracts all ATX and Setext headings from markdown content.
 */
export function getHeadings(content: string): HeadingItem[] {
	const lines = content.split(/\r?\n/);
	const headings: HeadingItem[] = [];

	let inCodeBlock = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Track code fence
		if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
			inCodeBlock = !inCodeBlock;
			continue;
		}

		if (inCodeBlock) continue;

		// 1. ATX headings (# Heading)
		const atxMatch = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/);
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
		if (i + 1 < lines.length) {
			const nextLine = lines[i + 1].trim();
			if (trimmed.length > 0 && /^[=-]{3,}$/.test(nextLine)) {
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
 */
export function findHeadingLine(content: string, headingPath: string): number | null {
	const headings = getHeadings(content);
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

	// Multi-segment heading path
	let currentIndex = 0;
	let lastMatchedLine: number | null = null;
	for (const heading of headings) {
		const hText = heading.text.trim().toLowerCase();
		if (hText === segments[currentIndex]) {
			lastMatchedLine = heading.line;
			currentIndex++;
			if (currentIndex === segments.length) {
				return lastMatchedLine;
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

	let inCodeBlock = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
			inCodeBlock = !inCodeBlock;
			continue;
		}

		if (inCodeBlock) continue;

		// Block reference: ^([a-zA-Z0-9-]+) at end of block or line
		const match = line.match(/\^([a-zA-Z0-9-]+)$/);
		if (match) {
			const id = match[1];
			// Preview is line content without the marker
			const preview = line.replace(/\^([a-zA-Z0-9-]+)$/, '').trim();
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
 */
export async function resolveTargetOrigin(
	workspace: Workspace,
	currentDoc: DocumentSession | null,
	targetPath: string
): Promise<FileOrigin | null> {
	if (!targetPath) {
		return currentDoc?.origin ?? null;
	}

	const normalizedTarget = targetPath.replace(/\\/g, '/');
	const hasExtension = /\.[a-zA-Z0-9]+$/.test(normalizedTarget);
	const targetWithExt = hasExtension ? normalizedTarget : `${normalizedTarget}.md`;
	const targetName = targetWithExt.split('/').pop()!;

	if (workspace.rootOrigin) {
		const rootPath = workspace.rootOrigin.path.replace(/\/$/, '');
		const scheme = workspace.rootOrigin.scheme;

		// 1. Direct path relative to workspace root
		const directRootOrigin: FileOrigin = {
			scheme,
			path: `${rootPath}/${targetWithExt.replace(/^\//, '')}`,
			name: targetName,
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
					path: `${currentDir}/${targetWithExt.replace(/^\//, '')}`,
					name: targetName,
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
			targetName,
			targetWithExt
		);
		if (vaultFound) {
			return vaultFound;
		}

		// 4. Note does not exist yet. Obsidian rule: create note at the link's folder path.
		const newPath = `${rootPath}/${targetWithExt.replace(/^\//, '')}`;
		const newOrigin: FileOrigin = {
			scheme,
			path: newPath,
			name: targetName,
		};
		// Create empty file
		await workspace.storage.saveFile('', newOrigin);
		return newOrigin;
	}

	return null;
}

/**
 * Resolves an internal link target and opens it in the workspace.
 * Sets pendingLineToScroll on the document session if heading or block is present.
 */
export async function openInternalLink(
	workspace: Workspace,
	currentDoc: DocumentSession | null,
	rawLink: string
): Promise<DocumentSession | null> {
	const parsed = parseInternalLink(rawLink);

	let targetDoc: DocumentSession | null = null;

	if (!parsed.path) {
		// Same-note anchor link (e.g. [[#Heading]] or [[#^block-id]])
		targetDoc = currentDoc ?? workspace.activeDocument;
	} else {
		// Target is in a note
		const targetOrigin = await resolveTargetOrigin(
			workspace,
			currentDoc,
			parsed.path
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
			} else {
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
			} else if (item.children) {
				walk(item.children);
			}
		}
	}
	walk(nodes);
	return files;
}
