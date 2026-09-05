import "../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import { createMockStorage } from "../../../tests/mock-storage";
import { toURI, type FileOrigin } from "./storage";

let parseInternalLink: any;
let findHeadingLine: any;
let findBlockLine: any;
let openInternalLink: any;
let Workspace: any;
let MemorySessionPersistence: any;

function createMemoryStorage(initialFiles: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initialFiles));
	const mockBase = createMockStorage();
	return {
		...mockBase,
		readFile: mock(async (origin: FileOrigin) => {
			const uri = toURI(origin);
			if (!files.has(uri)) {
				throw new Error(`File not found: ${uri}`);
			}
			return files.get(uri)!;
		}),
		saveFile: mock(async (content: string, origin?: FileOrigin) => {
			if (!origin) return null;
			files.set(toURI(origin), content);
			return origin;
		}),
		readDirectory: mock(async (origin: FileOrigin) => {
			const dirUri = toURI(origin).replace(/\/$/, "");
			const entries: any[] = [];
			const seen = new Set<string>();

			for (const uri of files.keys()) {
				if (uri.startsWith(`${dirUri}/`)) {
					const rest = uri.substring(dirUri.length + 1);
					const parts = rest.split("/");
					const entryName = parts[0];
					if (!seen.has(entryName)) {
						seen.add(entryName);
						const isDir = parts.length > 1;
						entries.push({
							name: entryName,
							kind: isDir ? "directory" : "file",
							origin: {
								scheme: origin.scheme,
								path: `${origin.path.replace(/\/$/, "")}/${entryName}`,
								name: entryName,
							},
						});
					}
				}
			}
			return entries;
		}),
		files,
	};
}

beforeAll(async () => {
	mock.module("svelte/reactivity", () => ({
		SvelteMap: Map,
		SvelteSet: Set,
	}));

	const linksMod = await import("./links");
	parseInternalLink = linksMod.parseInternalLink;
	findHeadingLine = linksMod.findHeadingLine;
	findBlockLine = linksMod.findBlockLine;
	openInternalLink = linksMod.openInternalLink;

	const workspaceMod = await import("./workspace.svelte");
	Workspace = workspaceMod.Workspace;

	const persistenceMod = await import("./persistence");
	MemorySessionPersistence = persistenceMod.MemorySessionPersistence;
});

describe("Obsidian Internal Link Parsing", () => {
	it("parses simple wikilink note name", () => {
		const parsed = parseInternalLink("[[Three laws of motion]]");
		expect(parsed.path).toBe("Three laws of motion");
		expect(parsed.subpath).toBeNull();
		expect(parsed.alias).toBeNull();
		expect(parsed.isEmbed).toBe(false);
	});

	it("parses wikilink with .md extension", () => {
		const parsed = parseInternalLink("[[Three laws of motion.md]]");
		expect(parsed.path).toBe("Three laws of motion.md");
		expect(parsed.subpath).toBeNull();
		expect(parsed.alias).toBeNull();
	});

	it("parses wikilink with folder path", () => {
		const parsed = parseInternalLink("[[Projects/Three laws of motion]]");
		expect(parsed.path).toBe("Projects/Three laws of motion");
		expect(parsed.subpath).toBeNull();
	});

	it("parses same-note heading link", () => {
		const parsed = parseInternalLink("[[#Preview a linked file]]");
		expect(parsed.path).toBe("");
		expect(parsed.subpath).toEqual({
			type: "heading",
			value: "Preview a linked file",
		});
		expect(parsed.alias).toBeNull();
	});

	it("parses other-note heading link", () => {
		const parsed = parseInternalLink("[[About Obsidian#Links are first-class citizens]]");
		expect(parsed.path).toBe("About Obsidian");
		expect(parsed.subpath).toEqual({
			type: "heading",
			value: "Links are first-class citizens",
		});
	});

	it("parses nested subheading links", () => {
		const parsed = parseInternalLink(
			"[[Help and support#Questions and advice#Report bugs and request features]]"
		);
		expect(parsed.path).toBe("Help and support");
		expect(parsed.subpath).toEqual({
			type: "heading",
			value: "Questions and advice#Report bugs and request features",
		});
	});

	it("parses same-note block link", () => {
		const parsed = parseInternalLink("[[#^37066d]]");
		expect(parsed.path).toBe("");
		expect(parsed.subpath).toEqual({
			type: "block",
			value: "37066d",
		});
	});

	it("parses other-note block link", () => {
		const parsed = parseInternalLink("[[2023-01-01#^quote-of-the-day]]");
		expect(parsed.path).toBe("2023-01-01");
		expect(parsed.subpath).toEqual({
			type: "block",
			value: "quote-of-the-day",
		});
	});

	it("parses custom display text (alias) with pipe syntax", () => {
		const parsed = parseInternalLink("[[Three laws of motion|The 3 laws]]");
		expect(parsed.path).toBe("Three laws of motion");
		expect(parsed.alias).toBe("The 3 laws");
	});

	it("parses heading link with custom display text", () => {
		const parsed = parseInternalLink(
			"[[About Obsidian#Links are first-class citizens|Custom Title]]"
		);
		expect(parsed.path).toBe("About Obsidian");
		expect(parsed.subpath).toEqual({
			type: "heading",
			value: "Links are first-class citizens",
		});
		expect(parsed.alias).toBe("Custom Title");
	});

	it("parses embed links with ! prefix", () => {
		const parsed = parseInternalLink("![[Figure 1.png]]");
		expect(parsed.path).toBe("Figure 1.png");
		expect(parsed.isEmbed).toBe(true);
		expect(parsed.alias).toBeNull();
	});

	it("parses embed link with alias / alt text", () => {
		const parsed = parseInternalLink("![[Figure 1.png|Alt text]]");
		expect(parsed.path).toBe("Figure 1.png");
		expect(parsed.isEmbed).toBe(true);
		expect(parsed.alias).toBe("Alt text");
	});

	it("handles raw link targets without outer brackets or percent-encoded markdown destinations", () => {
		const parsed = parseInternalLink("Three%20laws%20of%20motion.md#First%20Law");
		expect(parsed.path).toBe("Three laws of motion.md");
		expect(parsed.subpath).toEqual({
			type: "heading",
			value: "First Law",
		});
	});
});

describe("Markdown Heading and Block Matching", () => {
	const markdownContent = `# Main Title

Introductory paragraph with some notes.

## Section 1: Introduction
Here is the first section.
Sentence with a block marker. ^block-1

## Section 2: Deep Dive
Detailed analysis here.

### Sub-item A
Nested details.

> A blockquote on something.
^quote-block

## Section 3: Summary
Final thoughts.`;

	it("finds ATX heading line 1-indexed", () => {
		expect(findHeadingLine(markdownContent, "Main Title")).toBe(1);
		expect(findHeadingLine(markdownContent, "Section 1: Introduction")).toBe(5);
		expect(findHeadingLine(markdownContent, "Section 2: Deep Dive")).toBe(9);
		expect(findHeadingLine(markdownContent, "Sub-item A")).toBe(12);
	});

	it("finds heading case-insensitively and trimmed", () => {
		expect(findHeadingLine(markdownContent, "section 1: introduction")).toBe(5);
		expect(findHeadingLine(markdownContent, "  section 3: summary  ")).toBe(18);
	});

	it("finds nested subheading by path", () => {
		expect(
			findHeadingLine(markdownContent, "Section 2: Deep Dive#Sub-item A")
		).toBe(12);
	});

	it("returns null when heading is not found", () => {
		expect(findHeadingLine(markdownContent, "Nonexistent Heading")).toBeNull();
	});

	it("finds block line 1-indexed", () => {
		expect(findBlockLine(markdownContent, "block-1")).toBe(7);
		expect(findBlockLine(markdownContent, "quote-block")).toBe(16);
	});

	it("returns null when block id is not found", () => {
		expect(findBlockLine(markdownContent, "missing-block")).toBeNull();
	});
});

describe("openInternalLink resolution in Workspace", () => {
	let storage: any;
	let workspace: any;

	beforeEach(async () => {
		storage = createMemoryStorage({
			"file:///vault/Note A.md": "# Note A\nContent of Note A\n^ref-a",
			"file:///vault/Projects/Note B.md":
				"# Note B\n\n## Sub Section\nDetails on B",
		});

		workspace = new Workspace(
			storage,
			() => ({} as any),
			new MemorySessionPersistence()
		);

		workspace.rootOrigin = { scheme: "file", path: "/vault", name: "vault" };
		await workspace.projectTree.scan(workspace.rootOrigin);
	});

	it("navigates to heading within currently active note", async () => {
		const doc = await workspace.openFile({
			scheme: "file",
			path: "/vault/Projects/Note B.md",
			name: "Note B.md",
		});
		expect(doc).toBeDefined();

		const resultDoc = await openInternalLink(workspace, doc!, "[[#Sub Section]]");
		expect(resultDoc?.id).toBe(doc!.id);
		expect(resultDoc?.pendingLineToScroll).toBe(3);
	});

	it("navigates to block within currently active note", async () => {
		const doc = await workspace.openFile({
			scheme: "file",
			path: "/vault/Note A.md",
			name: "Note A.md",
		});
		expect(doc).toBeDefined();

		const resultDoc = await openInternalLink(workspace, doc!, "[[#^ref-a]]");
		expect(resultDoc?.id).toBe(doc!.id);
		expect(resultDoc?.pendingLineToScroll).toBe(3);
	});

	it("opens note in root by filename without extension", async () => {
		const resultDoc = await openInternalLink(workspace, null, "[[Note A]]");
		expect(resultDoc).toBeDefined();
		expect(resultDoc?.fileName).toBe("Note A.md");
		expect(resultDoc?.content).toContain("Content of Note A");
	});

	it("opens note in subfolder by filename (vault-wide resolution)", async () => {
		const resultDoc = await openInternalLink(workspace, null, "[[Note B]]");
		expect(resultDoc).toBeDefined();
		expect(resultDoc?.fileName).toBe("Note B.md");
		expect(resultDoc?.origin?.path).toBe("/vault/Projects/Note B.md");
	});

	it("opens note with explicit subfolder path", async () => {
		const resultDoc = await openInternalLink(
			workspace,
			null,
			"[[Projects/Note B]]"
		);
		expect(resultDoc).toBeDefined();
		expect(resultDoc?.origin?.path).toBe("/vault/Projects/Note B.md");
	});

	it("opens note and scrolls to target heading", async () => {
		const resultDoc = await openInternalLink(
			workspace,
			null,
			"[[Projects/Note B#Sub Section]]"
		);
		expect(resultDoc).toBeDefined();
		expect(resultDoc?.pendingLineToScroll).toBe(3);
	});

	it("creates note when target does not exist yet", async () => {
		const resultDoc = await openInternalLink(
			workspace,
			null,
			"[[New Idea Note]]"
		);
		expect(resultDoc).toBeDefined();
		expect(resultDoc?.fileName).toBe("New Idea Note.md");
		expect(storage.files.has("file:///vault/New Idea Note.md")).toBe(true);
	});

	it("never creates note when allowCreate is false", async () => {
		const resultDoc = await openInternalLink(
			workspace,
			null,
			"[[Missing Image.png]]",
			{ allowCreate: false }
		);
		expect(resultDoc).toBeNull();
		expect(storage.files.has("file:///vault/Missing Image.png")).toBe(false);
	});
});
