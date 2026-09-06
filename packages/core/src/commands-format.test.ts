import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock } from "bun:test";
import { registerCoreCommands, CommandRegistry } from "./commands.svelte";

function createMockAppState() {
	const commands = new CommandRegistry();
	const appState = {
		commands,
		activeEditorView: undefined as any
	};
	registerCoreCommands(appState as any);
	return appState;
}

function createMockEditorView(initialDoc: string, from: number, to: number = from) {
	let doc = initialDoc;
	let currentSelection = { from, to, empty: from === to };
	const dispatched: any[] = [];
	const createState = () => ({
		get selection() {
			return { main: currentSelection };
		},
		get doc() {
			return {
				length: doc.length,
				sliceString: (start: number, end: number) => doc.slice(start, end),
				toString: () => doc
			};
		}
	});
	let state = createState();
	const view = {
		get state() {
			return state;
		},
		focus: mock(() => {}),
		dispatch: mock((tr: any) => {
			dispatched.push(tr);
			if (tr.changes) {
				const cFrom = tr.changes.from ?? 0;
				const cTo = tr.changes.to ?? cFrom;
				const insert = tr.changes.insert ?? "";
				doc = doc.slice(0, cFrom) + insert + doc.slice(cTo);
			}
			if (tr.selection) {
				const anchor = tr.selection.anchor ?? 0;
				const head = tr.selection.head ?? anchor;
				currentSelection = {
					from: Math.min(anchor, head),
					to: Math.max(anchor, head),
					empty: anchor === head
				};
			}
			state = createState();
		})
	};
	return {
		view,
		dispatched,
		getDoc: () => doc,
		getSelection: () => currentSelection,
		setDoc: (nextDoc: string, nFrom = 0, nTo = nFrom) => {
			doc = nextDoc;
			currentSelection = { from: nFrom, to: nTo, empty: nFrom === nTo };
			state = createState();
		}
	};
}

describe("Markdown Formatting Commands", () => {
	it("checks isEnabled based on activeEditorView presence", () => {
		const appState = createMockAppState();
		const boldCmd = appState.commands.get("format.bold");
		expect(boldCmd).toBeDefined();
		expect(boldCmd?.isEnabled?.()).toBe(false);

		const mockEditor = createMockEditorView("Hello", 0);
		appState.activeEditorView = mockEditor.view;
		expect(boldCmd?.isEnabled?.()).toBe(true);
	});

	describe("Inline formatting", () => {
		it("format.bold: inserts empty markers and wraps selection", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("", 0);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.bold");
			expect(mockEditor.getDoc()).toBe("****");
			expect(mockEditor.getSelection().from).toBe(2);

			// Toggle off empty
			appState.commands.execute("format.bold");
			expect(mockEditor.getDoc()).toBe("");

			// Wrap selection
			mockEditor.setDoc("hello world", 0, 5);
			appState.commands.execute("format.bold");
			expect(mockEditor.getDoc()).toBe("**hello** world");

			// Unwrap selection
			mockEditor.setDoc("**hello** world", 0, 9);
			appState.commands.execute("format.bold");
			expect(mockEditor.getDoc()).toBe("hello world");
		});

		it("format.italic: inserts and wraps with *", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("italic text", 0, 6);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.italic");
			expect(mockEditor.getDoc()).toBe("*italic* text");

			appState.commands.execute("format.italic");
			expect(mockEditor.getDoc()).toBe("italic text");
		});

		it("format.strikethrough: inserts and wraps with ~~", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("deleted text", 0, 7);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.strikethrough");
			expect(mockEditor.getDoc()).toBe("~~deleted~~ text");
		});

		it("format.highlight: inserts and wraps with ==", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("important note", 0, 9);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.highlight");
			expect(mockEditor.getDoc()).toBe("==important== note");
		});

		it("format.code: inserts inline code `", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("const x = 1", 0, 11);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.code");
			expect(mockEditor.getDoc()).toBe("`const x = 1`");
		});

		it("format.inlineMath: inserts inline math $", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("E = mc^2", 0, 8);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.inlineMath");
			expect(mockEditor.getDoc()).toBe("$E = mc^2$");
		});

		it("format.comment: inserts comment %%", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("hidden comment", 0, 14);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.comment");
			expect(mockEditor.getDoc()).toBe("%%hidden comment%%");
		});

		it("format.link: inserts markdown link or wraps URL", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("", 0);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.link");
			expect(mockEditor.getDoc()).toBe("[](url)");

			// Regular text selection
			mockEditor.setDoc("Click here", 0, 10);
			appState.commands.execute("format.link");
			expect(mockEditor.getDoc()).toBe("[Click here](url)");

			// URL selection
			mockEditor.setDoc("https://example.com", 0, 19);
			appState.commands.execute("format.link");
			expect(mockEditor.getDoc()).toBe("[](https://example.com)");
		});

		it("format.footnote: inserts footnote marker", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("Fact", 4);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.footnote");
			expect(mockEditor.getDoc()).toBe("Fact[^1]");

			mockEditor.setDoc("myref", 0, 5);
			appState.commands.execute("format.footnote");
			expect(mockEditor.getDoc()).toBe("[^myref]");
		});
	});

	describe("Headings", () => {
		it("format.heading1 - format.heading6: toggles headings", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("My Title", 0);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.heading1");
			expect(mockEditor.getDoc()).toBe("# My Title");

			// Switch to heading 2
			appState.commands.execute("format.heading2");
			expect(mockEditor.getDoc()).toBe("## My Title");

			// Toggle heading 2 off
			appState.commands.execute("format.heading2");
			expect(mockEditor.getDoc()).toBe("My Title");

			// Test Heading 3
			appState.commands.execute("format.heading3");
			expect(mockEditor.getDoc()).toBe("### My Title");

			// Test Heading 4
			appState.commands.execute("format.heading4");
			expect(mockEditor.getDoc()).toBe("#### My Title");

			// Test Heading 5
			appState.commands.execute("format.heading5");
			expect(mockEditor.getDoc()).toBe("##### My Title");

			// Test Heading 6
			appState.commands.execute("format.heading6");
			expect(mockEditor.getDoc()).toBe("###### My Title");
		});
	});

	describe("Lists and Quotes", () => {
		it("format.bulletList: toggles bullet lists", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("First item\nSecond item", 0, 22);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.bulletList");
			expect(mockEditor.getDoc()).toBe("- First item\n- Second item");

			// Toggle off
			appState.commands.execute("format.bulletList");
			expect(mockEditor.getDoc()).toBe("First item\nSecond item");
		});

		it("format.numberedList: numbers list items", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("First\nSecond\nThird", 0, 18);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.numberedList");
			expect(mockEditor.getDoc()).toBe("1. First\n2. Second\n3. Third");

			// Toggle off
			appState.commands.execute("format.numberedList");
			expect(mockEditor.getDoc()).toBe("First\nSecond\nThird");
		});

		it("format.taskList: toggles task checkbox", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("Task item", 0);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.taskList");
			expect(mockEditor.getDoc()).toBe("- [ ] Task item");

			appState.commands.execute("format.taskList");
			expect(mockEditor.getDoc()).toBe("Task item");
		});

		it("format.blockquote: toggles blockquotes", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("A quote line\nAnother quote line", 0, 31);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.blockquote");
			expect(mockEditor.getDoc()).toBe("> A quote line\n> Another quote line");

			appState.commands.execute("format.blockquote");
			expect(mockEditor.getDoc()).toBe("A quote line\nAnother quote line");
		});
	});

	describe("Blocks and Templates", () => {
		it("format.codeBlock: inserts code block or wraps selection", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("", 0);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.codeBlock");
			expect(mockEditor.getDoc()).toBe("```\n\n```");

			mockEditor.setDoc("console.log(42);", 0, 16);
			appState.commands.execute("format.codeBlock");
			expect(mockEditor.getDoc()).toBe("```\nconsole.log(42);\n```");
		});

		it("format.blockMath: inserts block math", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("", 0);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.blockMath");
			expect(mockEditor.getDoc()).toBe("$$\n\n$$");

			mockEditor.setDoc("\\int_0^\\infty e^{-x} dx", 0, 23);
			appState.commands.execute("format.blockMath");
			expect(mockEditor.getDoc()).toBe("$$\n\\int_0^\\infty e^{-x} dx\n$$");
		});

		it("format.callout: inserts callout block", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("", 0);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.callout");
			expect(mockEditor.getDoc()).toBe("> [!note]\n> ");

			mockEditor.setDoc("Important warning message", 0, 25);
			appState.commands.execute("format.callout");
			expect(mockEditor.getDoc()).toBe("> [!note]\n> Important warning message");
		});

		it("format.horizontalRule: inserts horizontal divider", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("Section 1", 9);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.horizontalRule");
			expect(mockEditor.getDoc()).toBe("Section 1\n---\n");
		});

		it("format.table and format.insertTable: inserts 2x2 markdown table", () => {
			const appState = createMockAppState();
			const mockEditor = createMockEditorView("", 0);
			appState.activeEditorView = mockEditor.view;

			appState.commands.execute("format.table");
			expect(mockEditor.getDoc()).toContain("| Column 1 | Column 2 |");

			mockEditor.setDoc("", 0);
			appState.commands.execute("format.insertTable");
			expect(mockEditor.getDoc()).toContain("| Column 1 | Column 2 |");
		});
	});
});
