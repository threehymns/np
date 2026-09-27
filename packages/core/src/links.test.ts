import "../../../tests/contract/rune-setup";
import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";
import { createMockStorage } from "../../../tests/mock-storage";
import { toURI, type FileOrigin } from "./storage";

let parseInternalLink: any;
let findHeadingLine: any;
let findBlockLine: any;
let getHeadings: any;
let getBlocks: any;
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
	getHeadings = linksMod.getHeadings;
	getBlocks = linksMod.getBlocks;
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

	// `[[^id]]` is the form the editor's own completion produces: the user types
	// `[[^`, the block list opens, and the applied completion substitutes only the
	// id, so the resulting link has no `#` and therefore no path part. It is also
	// the spelling listed in this module's own doc comment.
	it("parses a bare same-note block link as a block, not a file named '^id'", () => {
		const parsed = parseInternalLink("[[^alpha]]");
		expect(parsed.path).toBe("");
		expect(parsed.subpath).toEqual({ type: "block", value: "alpha" });
		expect(parsed.alias).toBeNull();
	});

	it("parses a bare block link with a display alias", () => {
		const parsed = parseInternalLink("[[^alpha|the first block]]");
		expect(parsed.path).toBe("");
		expect(parsed.subpath).toEqual({ type: "block", value: "alpha" });
		expect(parsed.alias).toBe("the first block");
	});

	it("still treats an explicit note plus block id as a note link", () => {
		const parsed = parseInternalLink("[[About Obsidian#^alpha]]");
		expect(parsed.path).toBe("About Obsidian");
		expect(parsed.subpath).toEqual({ type: "block", value: "alpha" });
	});

	it("still treats '#^id' as a same-note block link", () => {
		const parsed = parseInternalLink("[[#^alpha]]");
		expect(parsed.path).toBe("");
		expect(parsed.subpath).toEqual({ type: "block", value: "alpha" });
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

	describe("nested heading paths must respect heading levels", () => {
		// A path segment may only match a heading NESTED UNDER the previous
		// match. Document order alone is not enough: matching by order made
		// "Two#Three" resolve to a sibling, and "Shared#Gamma" resolve to a
		// parent, both of which send the user to a line they did not ask for.
		const siblingDoc = ["# One", "a", "## Two", "b", "## Three", "c"].join("\n");
		const parentChildDoc = ["# Alpha", "x", "## Shared", "y", "# Gamma", "z", "## Shared", "w"].join("\n");

		it("does not match a path whose second segment is a sibling, not a child", () => {
			// "Three" is a sibling of "Two", so "Two#Three" names nothing.
			expect(findHeadingLine(siblingDoc, "Two#Three")).toBeNull();
		});

		it("does not match a path whose second segment is a parent", () => {
			// "Gamma" is the parent of "Shared", not a child of it.
			expect(findHeadingLine(parentChildDoc, "Shared#Gamma")).toBeNull();
		});

		it("resolves the correct one when a heading name repeats under different parents", () => {
			// Both "Shared" headings are real; the parent in the path decides.
			expect(findHeadingLine(parentChildDoc, "Alpha#Shared")).toBe(3);
			expect(findHeadingLine(parentChildDoc, "Gamma#Shared")).toBe(7);
		});

		it("still resolves a genuine multi-level path", () => {
			const deep = ["# A", "x", "## B", "y", "### C", "z"].join("\n");
			expect(findHeadingLine(deep, "A#B#C")).toBe(5);
		});

		it("treats a single-segment lookup as first match, unchanged", () => {
			// Ambiguous by design: a bare name has no parent to disambiguate it.
			expect(findHeadingLine(parentChildDoc, "Shared")).toBe(3);
		});
	});

	describe("fenced code blocks are not headings", () => {
		// getHeadings tracked fences with a bare boolean toggle, so any
		// fence-looking line flipped it. CommonMark is specific about what
		// opens and closes a fence, and each rule below is from the spec. A
		// heading inside a code block does not exist: it shows up as a phantom
		// entry in the outline and is reachable as a link target.
		const headings = (doc: string) =>
			getHeadings(doc).map((h) => `${h.level}:${h.text}@${h.line}`);

		it("does not let backticks close a tilde fence", () => {
			// A closing fence must use the same character as the opener.
			const doc = ["~~~", "```", "# not a heading", "~~~", "~~~"].join("\n");
			expect(headings(doc)).toEqual([]);
		});

		it("does not let a fence with an info string close a fence", () => {
			// A closing fence may not have an info string; "```text" is code.
			const doc = ["```", "body", "```text", "# not a heading", "```"].join("\n");
			expect(headings(doc)).toEqual([]);
		});

		it("does not let a shorter run close a longer fence", () => {
			// A 4-backtick fence is closed by 4 or more, never by 3.
			const doc = ["````", "body", "```", "# not a heading", "````"].join("\n");
			expect(headings(doc)).toEqual([]);
		});

		it("does not open a backtick fence whose info string contains a backtick", () => {
			// A backtick info string may not contain a backtick, so this is a
			// paragraph, and the heading after it is a real heading.
			const doc = ["```a`b", "# Real Heading"].join("\n");
			expect(headings(doc)).toEqual(["1:Real Heading@2"]);
		});

		it("still honours a plain fence", () => {
			// Control: the common case must keep working.
			const doc = ["# Real", "```", "# fake", "```", "# Also Real"].join("\n");
			expect(headings(doc)).toEqual(["1:Real@1", "1:Also Real@5"]);
		});

		it("treats an unclosed fence as running to the end of the document", () => {
			// CommonMark: an unclosed fence is still a code block.
			const doc = ["# Real", "```", "# fake", "still code"].join("\n");
			expect(headings(doc)).toEqual(["1:Real@1"]);
		});

		it("does not report a block id from inside a code fence", () => {
			// getBlocks had the same toggle, so a code sample could hand out a
			// block reference that the rest of the app would link to.
			const doc = ["# Real", "```", "text ^fake-id", "```"].join("\n");
			expect(getBlocks(doc)).toEqual([]);
		});
	});

	describe("getHeadings must agree with the app's own renderer", () => {
		// The editor renders Markdown with @codemirror/lang-markdown, so when
		// getHeadings and the renderer disagree, the outline shows something the
		// user cannot see and a [[Note#heading]] link points at a line that is
		// not a heading. The renderer is the oracle for these, measured by
		// scratch/lezer-heading-probe.ts.
		const headings = (doc: string) =>
			getHeadings(doc).map((h) => `${h.level}@${h.line}`);

		it("finds an ATX heading indented by up to three spaces", () => {
			// The regex was anchored to column 0, so any indentation hid a
			// heading the editor renders. Indenting under a list is common.
			expect(headings(" # One")).toEqual(["1@1"]);
			expect(headings("  # Two")).toEqual(["1@1"]);
			expect(headings("   # Three")).toEqual(["1@1"]);
		});

		it("does not treat four-space-indented ATX text as a heading", () => {
			// Four spaces is an indented code block, which the renderer agrees.
			expect(headings("    # Code")).toEqual([]);
		});

		it("does not make a list item a heading just because a rule follows", () => {
			// "- item" then "---" is a list followed by a thematic break, not a
			// setext heading. The outline was listing the list item as an H2.
			expect(headings("- item\n---")).toEqual([]);
		});

		it("does not make a blockquote line a heading", () => {
			expect(headings("> quoted\n---")).toEqual([]);
		});

		it("does not make an HTML block line a heading", () => {
			expect(headings("<div>x</div>\n---")).toEqual([]);
		});

		it("does not make an indented code line a heading", () => {
			expect(headings("    code\n---")).toEqual([]);
		});

		it("still finds a real setext heading", () => {
			// The plain paragraph case must keep working: this is the whole point
			// of the Setext branch.
			expect(headings("Title\n=====")).toEqual(["1@1"]);
			expect(headings("Title\n-----")).toEqual(["2@1"]);
		});

		it("still skips YAML frontmatter even though the renderer does not", () => {
			// Deliberate divergence, and the renderer is the one that is wrong
			// here: it reads the frontmatter's closing "---" as a setext
			// underline. Pinned by packages/ui/src/editor/frontmatter.test.ts.
			expect(headings("---\n# NotAHeading\ntags: [a]\n---\n# Real")).toEqual([
				"1@5",
			]);
		});
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

	it("returns null for same-note link when currentDoc is absent even if active document exists", async () => {
		const doc = await workspace.openFile({
			scheme: "file",
			path: "/vault/Projects/Note B.md",
			name: "Note B.md",
		});
		expect(doc).toBeDefined();
		expect(workspace.activeDocument).toBeDefined();

		const resultDoc = await openInternalLink(workspace, null, "[[#Sub Section]]");
		expect(resultDoc).toBeNull();
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

	// The damaging half of the bare-block-link bug. A `[[^alpha]]` link parsed as
	// a file target takes the "target is in a note" branch, where allowCreate
	// defaults to true for non-embeds -- so following a block reference silently
	// creates a junk note named `^alpha.md` in the user's vault and navigates to
	// that empty file instead of scrolling to the block.
	it("never creates a junk note when following a bare block reference", async () => {
		const resultDoc = await openInternalLink(workspace, null, "[[^alpha]]");
		expect(resultDoc).toBeNull();
		expect(storage.files.has("file:///vault/^alpha.md")).toBe(false);
	});
});
