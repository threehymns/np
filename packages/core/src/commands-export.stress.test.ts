import "../../../tests/contract/rune-setup";
import { describe, it, expect, mock, beforeAll } from "bun:test";
import type { ExportService, ClipboardService, ExportFileOptions } from "./state.svelte";
import { createMockStorage } from "../../../tests/mock-storage";
import { DocumentSession } from "./document.svelte";
import { transformer } from "./transformer";
import { HTMLExporter } from "./transformer/exporters/html";

let AppState: any;

beforeAll(async () => {
	const mod = await import("./state.svelte");
	AppState = mod.AppState;
});

function createTestAppState(overrides: {
	exportService?: ExportService;
	clipboardService?: ClipboardService;
} = {}) {
	const storage = createMockStorage();
	const appState = new AppState({
		storage,
		vcsFactory: () => ({} as any),
		exportService: overrides.exportService,
		clipboardService: overrides.clipboardService
	});
	return appState;
}

function setActiveDocument(appState: any, fileName: string, content: string) {
	const doc = new DocumentSession(
		appState.storage,
		content,
		{ scheme: "file", path: `/test/${fileName}`, name: fileName },
		fileName,
		appState.workspace
	);
	appState.workspace.documents = [doc];
	appState.workspace.tabs = [{ id: doc.id, type: "document" }];
	appState.workspace.activeTabId = doc.id;
	return doc;
}

describe("Adversarial Stress Suite: Export & Transformer Subsystem", () => {
	describe("1. Document Transformer & HTMLExporter Edge Cases", () => {
		const htmlExporter = new HTMLExporter();

		it("handles empty markdown string", async () => {
			const result = await htmlExporter.export("");
			expect(result).toContain("<!DOCTYPE html>");
			expect(result).toContain("<body>");
			expect(result).toContain("</body>");
		});

		it("handles whitespace-only markdown", async () => {
			const result = await htmlExporter.export("   \n\n\t\t\n   ");
			expect(result).toContain("<!DOCTYPE html>");
			expect(result).toContain("<body>");
			expect(result).toContain("</body>");
		});

		it("handles complex UTF-8, emojis, and non-Latin scripts", async () => {
			const content = `# 🚀 Unicode & Emojis 🎉\n\n- Arabic: مرحبا بالعالم\n- Hebrew: שלום עולם\n- Chinese: 你好世界\n- Math: ∑_{i=1}^n x_i = 42\n- Japanese: こんにちは世界`;
			const result = await htmlExporter.export(content);
			expect(result).toContain("🚀 Unicode &amp; Emojis 🎉");
			expect(result).toContain("مرحبا بالعالم");
			expect(result).toContain("שלום עולם");
			expect(result).toContain("你好世界");
			expect(result).toContain("こんにちは世界");
		});

		it("handles raw HTML and XSS payloads in markdown without crashing", async () => {
			const content = `# Security Test\n\n<script>alert('xss')</script>\n<img src="x" onerror="alert(1)" />\n<iframe src="https://example.com"></iframe>`;
			const result = await htmlExporter.export(content);
			expect(result).toContain("Security Test");
			expect(result).toContain("<script>alert('xss')</script>");
		});

		it("handles malformed markdown (unclosed tags, broken tables, deep recursion)", async () => {
			const brokenMarkdown = `
| Header 1 | Header 2
| --- |
| row 1 | row 2 | extra |

> Unclosed blockquote
>> Nested unclosed
>>> Triple nested

* List item 1
  * Sublist without space
    * Deep list 3
      * Deep list 4
        * Deep list 5

\`\`\`typescript
const unclosedCode = "no closing backticks";
`;
			const result = await htmlExporter.export(brokenMarkdown);
			expect(result).toContain("<!DOCTYPE html>");
			expect(result).toContain("Unclosed blockquote");
			expect(result).toContain("const unclosedCode");
		});

		it("stress tests huge markdown documents (10,000 lines / ~1MB)", async () => {
			const lines: string[] = [];
			lines.push("# Massive Markdown Stress Document\n");
			for (let i = 0; i < 5000; i++) {
				lines.push(`## Section ${i}\n`);
				lines.push(`This is paragraph **${i}** with [link](https://example.com/${i}) and \`inline_code_${i}\`.\n`);
				lines.push(`> Quote ${i}: *Life is short, code is long.*\n`);
				lines.push(`| Col A | Col B |\n| --- | --- |\n| Val ${i}A | Val ${i}B |\n`);
			}
			const hugeContent = lines.join("\n");
			expect(hugeContent.length).toBeGreaterThan(500000);

			const startTime = Date.now();
			const result = await transformer.transform(hugeContent, "html");
			const elapsedMs = Date.now() - startTime;

			expect(result).toContain("Massive Markdown Stress Document");
			expect(result).toContain("Section 4999");
			expect(elapsedMs).toBeLessThan(10000); // Should complete within 10 seconds
		});

		it("throws for unsupported transform formats", async () => {
			await expect(transformer.transform("# Hello", "pdf")).rejects.toThrow(
				"Unsupported export format: pdf"
			);
			await expect(transformer.transform("# Hello", "docx")).rejects.toThrow(
				"Unsupported export format: docx"
			);
		});
	});

	describe("2. Filename Edge Cases & Suggested Name Resolution", () => {
		it("replaces .md suffix correctly", async () => {
			let capturedOptions: ExportFileOptions | null = null;
			const appState = createTestAppState({
				exportService: {
					exportFile: mock(async (opts) => {
						capturedOptions = opts;
					})
				}
			});
			setActiveDocument(appState, "Simple.md", "# Hello");
			await appState.commands.execute("transformer.exportHTML");

			expect(capturedOptions).not.toBeNull();
			expect(capturedOptions!.suggestedName).toBe("Simple.html");
		});

		it("handles files without .md extension", async () => {
			let capturedOptions: ExportFileOptions | null = null;
			const appState = createTestAppState({
				exportService: {
					exportFile: mock(async (opts) => {
						capturedOptions = opts;
					})
				}
			});
			setActiveDocument(appState, "Notes.txt", "# Hello");
			await appState.commands.execute("transformer.exportHTML");

			expect(capturedOptions).not.toBeNull();
			expect(capturedOptions!.suggestedName).toBe("Notes.txt.html");
		});

		it("handles files with multiple dots in filename", async () => {
			let capturedOptions: ExportFileOptions | null = null;
			const appState = createTestAppState({
				exportService: {
					exportFile: mock(async (opts) => {
						capturedOptions = opts;
					})
				}
			});
			setActiveDocument(appState, "archive.v1.2.3.md", "# Hello");
			await appState.commands.execute("transformer.exportHTML");

			expect(capturedOptions).not.toBeNull();
			expect(capturedOptions!.suggestedName).toBe("archive.v1.2.3.html");
		});

		it("handles filenames with spaces, unicode, and symbols", async () => {
			let capturedOptions: ExportFileOptions | null = null;
			const appState = createTestAppState({
				exportService: {
					exportFile: mock(async (opts) => {
						capturedOptions = opts;
					})
				}
			});
			setActiveDocument(appState, "Project 🌟 [Draft] & 'Notes'.md", "# Hello");
			await appState.commands.execute("transformer.exportHTML");

			expect(capturedOptions).not.toBeNull();
			expect(capturedOptions!.suggestedName).toBe("Project 🌟 [Draft] & 'Notes'.html");
		});
	});

	describe("3. Adversarial ExportService & Error Path Hardening", () => {
		it("suppresses standard AbortError DOMException without unhandled rejection", async () => {
			const abortErr = typeof DOMException !== "undefined"
				? new DOMException("The user aborted a request.", "AbortError")
				: Object.assign(new Error("User aborted"), { name: "AbortError" });

			const appState = createTestAppState({
				exportService: {
					exportFile: mock(async () => {
						throw abortErr;
					})
				}
			});
			setActiveDocument(appState, "Doc.md", "Content");

			// Should not throw or reject
			await appState.commands.execute("transformer.exportHTML");
		});

		it("catches and logs non-AbortError exceptions without crashing the application", async () => {
			const originalConsoleError = console.error;
			let loggedError: any = null;
			console.error = (...args: any[]) => {
				loggedError = args;
			};

			try {
				const appState = createTestAppState({
					exportService: {
						exportFile: mock(async () => {
							throw new Error("EACCES: permission denied, write");
						})
					}
				});
				setActiveDocument(appState, "Doc.md", "Content");

				await appState.commands.execute("transformer.exportHTML");
				expect(loggedError).not.toBeNull();
				expect(loggedError[0]).toBe("Failed to export HTML:");
			} finally {
				console.error = originalConsoleError;
			}
		});

		it("handles non-standard thrown objects (strings, null, undefined, custom objects)", async () => {
			const originalConsoleError = console.error;
			console.error = () => {};

			try {
				// String throw
				const appState1 = createTestAppState({
					exportService: {
						exportFile: mock(async () => {
							throw "string error";
						})
					}
				});
				setActiveDocument(appState1, "Doc.md", "Content");
				await appState1.commands.execute("transformer.exportHTML");

				// Object without name property
				const appState2 = createTestAppState({
					exportService: {
						exportFile: mock(async () => {
							throw { code: 500, message: "custom failure" };
						})
					}
				});
				setActiveDocument(appState2, "Doc.md", "Content");
				await appState2.commands.execute("transformer.exportHTML");
			} finally {
				console.error = originalConsoleError;
			}
		});

		it("gracefully no-ops when exportService is undefined", async () => {
			const appState = createTestAppState({ exportService: undefined });
			setActiveDocument(appState, "Doc.md", "Content");
			await appState.commands.execute("transformer.exportHTML");
		});

		it("gracefully no-ops when exportFile method is undefined on exportService", async () => {
			const appState = createTestAppState({ exportService: {} as any });
			setActiveDocument(appState, "Doc.md", "Content");
			await appState.commands.execute("transformer.exportHTML");
		});

		it("gracefully no-ops when no active document is open", async () => {
			const exportFileMock = mock(async () => {});
			const appState = createTestAppState({
				exportService: { exportFile: exportFileMock }
			});
			appState.workspace.documents = [];
			appState.workspace.tabs = [];
			appState.workspace.activeTabId = "";

			await appState.commands.execute("transformer.exportHTML");
			expect(exportFileMock).not.toHaveBeenCalled();
		});
	});

	describe("4. Clipboard / copyHTML Subsystem Hardening", () => {
		it("copies formatted HTML for active document", async () => {
			let copiedText = "";
			const appState = createTestAppState({
				clipboardService: {
					writeText: mock(async (text) => {
						copiedText = text;
					})
				}
			});
			setActiveDocument(appState, "Note.md", "# Heading\n\nBold **text**");

			await appState.commands.execute("transformer.copyHTML");
			expect(copiedText).toContain("<h1");
			expect(copiedText).toContain("Heading");
			expect(copiedText).toContain("<strong>text</strong>");
		});

		it("handles clipboardService errors without crashing", async () => {
			const originalConsoleError = console.error;
			let errorLogged = false;
			console.error = () => {
				errorLogged = true;
			};

			try {
				const appState = createTestAppState({
					clipboardService: {
						writeText: mock(async () => {
							throw new Error("Clipboard write access denied");
						})
					}
				});
				setActiveDocument(appState, "Note.md", "Content");

				await appState.commands.execute("transformer.copyHTML");
				expect(errorLogged).toBe(true);
			} finally {
				console.error = originalConsoleError;
			}
		});

		it("no-ops when activeDocument is missing", async () => {
			const writeMock = mock(async () => {});
			const appState = createTestAppState({
				clipboardService: { writeText: writeMock }
			});
			appState.workspace.documents = [];
			appState.workspace.tabs = [];
			appState.workspace.activeTabId = "";

			await appState.commands.execute("transformer.copyHTML");
			expect(writeMock).not.toHaveBeenCalled();
		});

		it("no-ops when clipboardService is undefined", async () => {
			const appState = createTestAppState({ clipboardService: undefined });
			setActiveDocument(appState, "Note.md", "Content");
			await appState.commands.execute("transformer.copyHTML");
		});

		it("no-ops when writeText is undefined on clipboardService", async () => {
			const appState = createTestAppState({ clipboardService: {} as any });
			setActiveDocument(appState, "Note.md", "Content");
			await appState.commands.execute("transformer.copyHTML");
		});
	});

	describe("5. Platform ExportService Implementation Simulations", () => {
		it("simulates Desktop ExportService (saveFileDialog -> writeFile)", async () => {
			let savedFilePath = "";
			let writtenContent = "";

			const mockElectronAPI = {
				saveFileDialog: mock(async (opts: any) => {
					expect(opts.defaultPath).toBe("Doc.html");
					expect(opts.filters).toBeDefined();
					expect(opts.filters[0].extensions).toEqual(["html"]);
					return "/saved/path/Doc.html";
				}),
				writeFile: mock(async (filePath: string, content: string) => {
					savedFilePath = filePath;
					writtenContent = content;
				})
			};

			const desktopExportService: ExportService = {
				exportFile: async ({ content, suggestedName, types }) => {
					const fileName = suggestedName || "export.html";
					const filters = types?.map(t => ({
						name: t.description,
						extensions: Object.values(t.accept).flat().map(ext => ext.replace(/^\./, ""))
					})) ?? [{ name: "All Files", extensions: ["*"] }];

					if (mockElectronAPI?.saveFileDialog) {
						const filePath = await mockElectronAPI.saveFileDialog({
							defaultPath: fileName,
							filters
						});
						if (filePath) {
							await mockElectronAPI.writeFile(filePath, content);
						}
					}
				}
			};

			const appState = createTestAppState({ exportService: desktopExportService });
			setActiveDocument(appState, "Doc.md", "# Desktop Export");

			await appState.commands.execute("transformer.exportHTML");

			expect(mockElectronAPI.saveFileDialog).toHaveBeenCalledTimes(1);
			expect(mockElectronAPI.writeFile).toHaveBeenCalledTimes(1);
			expect(savedFilePath).toBe("/saved/path/Doc.html");
			expect(writtenContent).toContain("Desktop Export");
		});

		it("simulates Desktop ExportService user cancellation (saveFileDialog returns null)", async () => {
			const mockElectronAPI = {
				saveFileDialog: mock(async () => null),
				writeFile: mock(async () => {})
			};

			const desktopExportService: ExportService = {
				exportFile: async ({ content, suggestedName, types }) => {
					const fileName = suggestedName || "export.html";
					const filters = types?.map(t => ({
						name: t.description,
						extensions: Object.values(t.accept).flat().map(ext => ext.replace(/^\./, ""))
					})) ?? [{ name: "All Files", extensions: ["*"] }];

					if (mockElectronAPI?.saveFileDialog) {
						const filePath = await mockElectronAPI.saveFileDialog({
							defaultPath: fileName,
							filters
						});
						if (filePath) {
							await mockElectronAPI.writeFile(filePath, content);
						}
					}
				}
			};

			const appState = createTestAppState({ exportService: desktopExportService });
			setActiveDocument(appState, "Doc.md", "# Cancelled Doc");

			await appState.commands.execute("transformer.exportHTML");

			expect(mockElectronAPI.saveFileDialog).toHaveBeenCalledTimes(1);
			expect(mockElectronAPI.writeFile).not.toHaveBeenCalled();
		});

		it("simulates Web ExportService (showSaveFilePicker API)", async () => {
			let writtenContent = "";
			let closed = false;

			const mockWritable = {
				write: mock(async (data: string) => {
					writtenContent = data;
				}),
				close: mock(async () => {
					closed = true;
				})
			};

			const mockFileHandle = {
				createWritable: mock(async () => mockWritable)
			};

			const mockShowSaveFilePicker = mock(async (opts: any) => {
				expect(opts.suggestedName).toBe("WebDoc.html");
				return mockFileHandle;
			});

			const webExportService: ExportService = {
				exportFile: async ({ content, suggestedName, mimeType, types }) => {
					const fileName = suggestedName || "export.html";
					try {
						const handle = await mockShowSaveFilePicker({
							suggestedName: fileName,
							types: types ?? (mimeType ? [{ description: "Files", accept: { [mimeType]: [] } }] : undefined)
						});
						const writable = await handle.createWritable();
						await writable.write(content);
						await writable.close();
					} catch (e) {
						if ((e as Error).name !== "AbortError") throw e;
					}
				}
			};

			const appState = createTestAppState({ exportService: webExportService });
			setActiveDocument(appState, "WebDoc.md", "# Web Export Content");

			await appState.commands.execute("transformer.exportHTML");

			expect(mockShowSaveFilePicker).toHaveBeenCalledTimes(1);
			expect(mockFileHandle.createWritable).toHaveBeenCalledTimes(1);
			expect(writtenContent).toContain("Web Export Content");
			expect(closed).toBe(true);
		});

		it("simulates Web ExportService AbortError in showSaveFilePicker", async () => {
			const abortErr = new Error("User dismissed save picker");
			abortErr.name = "AbortError";

			const mockShowSaveFilePicker = mock(async () => {
				throw abortErr;
			});

			const webExportService: ExportService = {
				exportFile: async ({ content, suggestedName, mimeType, types }) => {
					const fileName = suggestedName || "export.html";
					try {
						const handle = await mockShowSaveFilePicker({
							suggestedName: fileName,
							types: types ?? (mimeType ? [{ description: "Files", accept: { [mimeType]: [] } }] : undefined)
						});
						const writable = await handle.createWritable();
						await writable.write(content);
						await writable.close();
					} catch (e) {
						if ((e as Error).name !== "AbortError") throw e;
					}
				}
			};

			const appState = createTestAppState({ exportService: webExportService });
			setActiveDocument(appState, "Doc.md", "# Aborted Web Doc");

			await appState.commands.execute("transformer.exportHTML");
			expect(mockShowSaveFilePicker).toHaveBeenCalledTimes(1);
		});
	});
});
