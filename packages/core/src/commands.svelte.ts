import { undo, redo, selectAll } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import type { AppState } from "./state.svelte";

import { transformer } from "./transformer";
import { allLanguages } from "./editor/language.svelte";
import { parseURI, toURI, type FileOrigin } from "./storage";
import { type GitChange, DEFAULT_DIFF_CONFIG } from "./project/vcs";
import { runExclusively } from "./project/repository.svelte";

async function showAlert(appState: AppState, msg: string): Promise<void> {
	if (appState.dialogService?.alert) {
		await appState.dialogService.alert(msg);
	}
}

async function showConfirm(appState: AppState, msg: string): Promise<boolean> {
	if (appState.dialogService?.confirm) {
		return Boolean(await appState.dialogService.confirm(msg));
	}
	return false;
}

async function writeClipboard(appState: AppState, text: string): Promise<void> {
	if (!appState.clipboardService?.writeText) {
		throw new Error('Clipboard service is unavailable');
	}
	await appState.clipboardService.writeText(text);
}

async function readClipboard(appState: AppState): Promise<string> {
	if (appState.clipboardService?.readText) {
		return await appState.clipboardService.readText();
	}
	return '';
}

/**
 * True for absolute filesystem paths in any common form: POSIX ('/a/b'),
 * Windows drive ('C:\a\b', 'C:/a/b'), and UNC ('\\\\server\\share').
 * URI strings ('scheme://...') are classified separately before this runs.
 */
function isAbsoluteFilesystemPath(target: string): boolean {
	return target.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(target) || target.startsWith('\\\\');
}

export interface Command {
	id: string;
	label: string;
	category: string;
	action: (...args: any[]) => any;
	isVisible?: () => boolean;
	isEnabled?: () => boolean;
}

export class CommandRegistry {
	private commands = $state<Command[]>([]);

	register(command: Command) {
		this.commands.push(command);
	}

	get(id: string) {
		return this.commands.find(c => c.id === id);
	}

	getAll() {
		return Array.from(this.commands.values());
	}

	getByCategory(category: string) {
		return this.commands.filter(c => c.category === category);
	}

	execute(id: string, ...args: any[]) {
		const command = this.get(id);
		if (command && (!command.isEnabled || command.isEnabled())) {
			return command.action(...args);
		}
	}
}

// Initial registration of core commands
export function registerCoreCommands(appState: AppState) {
	appState.commands.register({
		id: 'file.new',
		label: 'New',
		category: 'File',
		action: () => { appState.newFile(); }
	});

	const openFileAction = async (target?: string | FileOrigin) => {
		if (!target) {
			await appState.openFile();
			return;
		}
		if (typeof target !== 'string') {
			await appState.workspace.openFile(target);
			return;
		}
		if (target.includes('://')) {
			await appState.workspace.openFile(parseURI(target));
		} else if (isAbsoluteFilesystemPath(target)) {
			const name = target.split(/[/\\]/).filter(Boolean).pop() || target;
			await appState.workspace.openFile({
				scheme: 'file',
				path: target,
				name
			});
		} else if (appState.workspace.rootOrigin) {
			const rootUri = toURI(appState.workspace.rootOrigin);
			const fileUri = `${rootUri.replace(/\/$/, '')}/${target.replace(/^\//, '')}`;
			await appState.workspace.openFile(parseURI(fileUri));
		} else {
			console.error(`Cannot open '${target}': open a folder first to resolve relative paths.`);
		}
	};

	appState.commands.register({
		id: 'file.open',
		label: 'Open...',
		category: 'File',
		action: openFileAction
	});

	appState.commands.register({
		id: 'file.openFolder',
		label: 'Open Folder...',
		category: 'File',
		action: () => appState.workspace.openDirectory()
	});

	appState.commands.register({
		id: 'file.save',
		label: 'Save',
		category: 'File',
		action: () => appState.saveFile()
	});

	appState.commands.register({
		id: 'file.saveAs',
		label: 'Save As...',
		category: 'File',
		action: () => appState.saveFileAs()
	});

	appState.commands.register({
		id: 'edit.undo',
		label: 'Undo',
		category: 'Edit',
		action: () => {
			if (appState.activeEditorView) {
				undo(appState.activeEditorView);
				appState.activeEditorView.focus();
			}
		},
		isEnabled: () => !!appState.activeEditorView
	});

	appState.commands.register({
		id: 'edit.redo',
		label: 'Redo',
		category: 'Edit',
		action: () => {
			if (appState.activeEditorView) {
				redo(appState.activeEditorView);
				appState.activeEditorView.focus();
			}
		},
		isEnabled: () => !!appState.activeEditorView
	});

	appState.commands.register({
		id: 'edit.cut',
		label: 'Cut',
		category: 'Edit',
		action: async () => {
			if (appState.activeEditorView) {
				const view = appState.activeEditorView;
				view.focus();
				const state = view.state;
				const { from, to } = state.selection.main;
				if (from !== to) {
					const text = state.doc.sliceString(from, to);
					try {
						await writeClipboard(appState, text);
						// Only delete the selection if the editor state hasn't
						// changed while the clipboard write was in flight.
						if (view.state === state) {
							view.dispatch({
								changes: { from, to, insert: "" },
								selection: { anchor: from }
							});
						}
					} catch (err) {
						console.error("Failed to cut to clipboard:", err);
					}
				}
			}
		},
		isEnabled: () => !!appState.activeEditorView
	});

	appState.commands.register({
		id: 'edit.copy',
		label: 'Copy',
		category: 'Edit',
		action: async () => {
			if (appState.activeEditorView) {
				const view = appState.activeEditorView;
				const { from, to } = view.state.selection.main;
				if (from !== to) {
					const text = view.state.doc.sliceString(from, to);
					try {
						await writeClipboard(appState, text);
					} catch (err) {
						console.error("Failed to copy to clipboard:", err);
					}
				}
				view.focus();
			}
		},
		isEnabled: () => !!appState.activeEditorView
	});

	appState.commands.register({
		id: 'edit.paste',
		label: 'Paste',
		category: 'Edit',
		action: async () => {
			if (appState.activeEditorView) {
				const view = appState.activeEditorView;
				try {
					const text = await readClipboard(appState);
					if (text) {
						view.dispatch(view.state.replaceSelection(text));
						view.focus();
					}
				} catch (err) {
					console.error("Failed to read clipboard:", err);
				}
			}
		},
		isEnabled: () => !!appState.activeEditorView
	});

	appState.commands.register({
		id: 'edit.find',
		label: 'Find...',
		category: 'Edit',
		action: () => appState.activeEditorView && openSearchPanel(appState.activeEditorView),
		isEnabled: () => !!appState.activeEditorView
	});

	appState.commands.register({
		id: 'edit.addInternalLink',
		label: 'Add internal link',
		category: 'Edit',
		action: () => {
			if (!appState.activeEditorView) return;
			const view = appState.activeEditorView;
			const selection = view.state.selection.main;
			if (selection.empty) {
				view.dispatch({
					changes: { from: selection.from, insert: '[[]]' },
					selection: { anchor: selection.from + 2 }
				});
			} else {
				const text = view.state.doc.sliceString(selection.from, selection.to);
				view.dispatch({
					changes: { from: selection.from, to: selection.to, insert: `[[${text}]]` },
					selection: { anchor: selection.from + 2, head: selection.to + 2 }
				});
			}
			view.focus();
		},
		isEnabled: () => !!appState.activeEditorView
	});

	appState.commands.register({
		id: 'edit.selectAll',
		label: 'Select All',
		category: 'Edit',
		action: () => {
			if (appState.activeEditorView) {
				selectAll(appState.activeEditorView);
				appState.activeEditorView.focus();
			}
		},
		isEnabled: () => !!appState.activeEditorView
	});

	appState.commands.register({
		id: 'transformer.copyHTML',
		label: 'Copy as HTML',
		category: 'Export',
		action: async () => {
			if (!appState.activeDocument) return;
			const html = await transformer.transform(appState.activeDocument.content, 'html');
			try {
				await writeClipboard(appState, html);
			} catch (err) {
				console.error("Failed to copy HTML to clipboard:", err);
			}
		}
	});

	appState.commands.register({
		id: 'transformer.exportHTML',
		label: 'Export to HTML...',
		category: 'Export',
		action: async () => {
			if (!appState.activeDocument) return;
			const html = await transformer.transform(appState.activeDocument.content, 'html');
			const suggestedName = appState.activeDocument.fileName.replace(/\.md$/, '') + '.html';

			try {
				await appState.exportService?.exportFile({
					content: html,
					suggestedName,
					mimeType: 'text/html',
					types: [{ description: 'HTML Files', accept: { 'text/html': ['.html'] } }]
				});
			} catch (e) {
				if ((e as { name?: string } | null | undefined)?.name !== 'AbortError') {
					console.error('Failed to export HTML:', e);
				}
			}
		}
	});


  appState.commands.register({
    id: 'commandPalette.toggle',
    label: 'Command Palette: Toggle',
    category: 'View',
    action: () => {
      appState.commandPalette.open = !appState.commandPalette.open;
    }
  });

	appState.commands.register({
		id: 'edit.changeLanguageMode',
		label: 'Change Language Mode',
		category: 'Edit',
		action: () => {
			if (!appState.activeDocument) return;
			const currentDoc = appState.activeDocument;

			const langItems = [
				{
					id: 'auto',
					label: 'Auto Detect',
					meta: currentDoc.userLanguageOverride === null ? 'Configured Language' : undefined,
					icon: 'language',
					action: () => {
						currentDoc.userLanguageOverride = null;
						appState.commandPalette.reset();
					}
				},
				{
					id: 'text',
					label: 'Plain Text',
					meta: currentDoc.userLanguageOverride === 'Plain Text' ? 'Configured Language' : undefined,
					icon: 'file',
					action: () => {
						currentDoc.userLanguageOverride = 'Plain Text';
						appState.commandPalette.reset();
					}
				},
				...allLanguages.map(lang => {
					const isCurrent = currentDoc.userLanguageOverride === lang.name ||
						(currentDoc.userLanguageOverride === null && currentDoc.language?.name === lang.name);

					let packageId = '';
					const nameMap: Record<string, string> = {
						"C++": "@codemirror/lang-cpp",
						"HTML": "@codemirror/lang-html",
						"Java": "@codemirror/lang-java",
						"JavaScript": "@codemirror/lang-javascript",
						"TypeScript": "@codemirror/lang-javascript",
						"JSX": "@codemirror/lang-javascript",
						"TSX": "@codemirror/lang-javascript",
						"JSON": "@codemirror/lang-json",
						"Markdown": "@codemirror/lang-markdown",
						"Python": "@codemirror/lang-python",
						"Rust": "@codemirror/lang-rust",
						"SQL": "@codemirror/lang-sql",
						"Svelte": "@replit/codemirror-lang-svelte",
						"CSS": "@codemirror/lang-css",
					};
					packageId = nameMap[lang.name] || `@codemirror/lang-${lang.name.toLowerCase()}`;

					return {
						id: lang.name,
						label: lang.name,
						meta: isCurrent ? 'Configured Language' : undefined,
						icon: lang.name,
						action: () => {
							currentDoc.userLanguageOverride = lang.name;
							appState.commandPalette.reset();
						}
					};
				})
			];

			appState.commandPalette.openWith({
				placeholder: 'Select Language Mode...',
				items: langItems
			});
		}
	});

	appState.commands.register({
		id: 'view.toggleSidebar',
		label: 'Toggle Sidebar',
		category: 'View',
		action: () => {
			appState.prefs.sidebarVisible = !appState.prefs.sidebarVisible;
		}
	});

	appState.commands.register({
		id: 'view.zoomIn',
		label: 'Zoom In',
		category: 'View',
		action: () => appState.prefs.zoomIn()
	});

	appState.commands.register({
		id: 'view.zoomOut',
		label: 'Zoom Out',
		category: 'View',
		action: () => appState.prefs.zoomOut()
	});

	appState.commands.register({
		id: 'view.zoomReset',
		label: 'Restore Default Zoom',
		category: 'View',
		action: () => appState.prefs.resetZoom()
	});

	appState.commands.register({
		id: 'view.toggleStatusBar',
		label: 'Status Bar',
		category: 'View',
		action: () => {
			appState.prefs.statusBar = !appState.prefs.statusBar;
		}
	});

	appState.commands.register({
		id: 'format.toggleWordWrap',
		label: 'Word Wrap',
		category: 'Format',
		action: () => {
			appState.prefs.wordWrap = !appState.prefs.wordWrap;
		}
	});

	appState.commands.register({
		id: 'window.toggleDevTools',
		label: 'Toggle Developer Tools',
		category: 'Window',
		action: () => {
			if (typeof window !== 'undefined' && (window as any).electronAPI?.toggleDevTools) {
				(window as any).electronAPI.toggleDevTools();
			}
		},
		isVisible: () => typeof window !== 'undefined' && !!(window as any).electronAPI
	});

	appState.commands.register({
		id: 'settings.open',
		label: 'Preferences: Open Settings',
		category: 'Preferences',
		action: () => {
			appState.settingsOpen = true;
		}
	});

	appState.commands.register({
		id: 'settings.openConfigJson',
		label: 'Preferences: Open Settings (JSON)',
		category: 'Preferences',
		action: async () => {
			if (typeof window !== 'undefined' && (window as any).electronAPI?.getConfigPath) {
				try {
					const configPath = await (window as any).electronAPI.getConfigPath();
					if (configPath) {
						const name = configPath.split(/[/\\]/).filter(Boolean).pop() || 'config.json';
						await appState.workspace.openFile({
							scheme: 'file',
							path: configPath,
							name
						});
						appState.settingsOpen = false;
						return;
					}
				} catch (e) {
					console.error('Failed to open config file:', e);
				}
			}
			await showAlert(appState, 'Configuration file is only available in the desktop application.');
		}
	});

	appState.commands.register({
		id: 'keybindings.open',
		label: 'Preferences: Open Keymaps (JSON)',
		category: 'Preferences',
		action: () => {
			appState.workspace.openFile(parseURI('keymap://user/keymap.json'));
			appState.settingsOpen = false;
		}
	});

	async function runGitOp(
		label: string,
		op: (repo: NonNullable<typeof appState.workspace.repository>) => Promise<void>
	): Promise<boolean> {
		const repo = appState.workspace.repository;
		if (!repo) return false;
		try {
			return await runExclusively(repo, async () => {
				await op(repo);
				await repo.refresh();
				return true;
			});
		} catch (e) {
			console.error(`${label} failed:`, e);
			await showAlert(appState, `${label} failed: ${(e as Error).message}`);
			return false;
		}
	}

	appState.commands.register({
		id: 'git.stage',
		label: 'Git: Stage File',
		category: 'Source Control',
		action: async (filepath: string) => {
			if (!filepath) return false;
			const repo = appState.workspace.repository;
			if (repo?.adapter.stageFile) {
				return await runGitOp(`Failed to stage file '${filepath}'`, async (r) => {
					await r.adapter.stageFile!(filepath);
				});
			}
			return false;
		}
	});

	appState.commands.register({
		id: 'git.unstage',
		label: 'Git: Unstage File',
		category: 'Source Control',
		action: async (filepath: string) => {
			if (!filepath) return false;
			const repo = appState.workspace.repository;
			if (repo?.adapter.unstageFile) {
				return await runGitOp(`Failed to unstage file '${filepath}'`, async (r) => {
					await r.adapter.unstageFile!(filepath);
				});
			}
			return false;
		}
	});

	appState.commands.register({
		id: 'git.discard',
		label: 'Git: Discard Changes',
		category: 'Source Control',
		action: async (filepath: string, options?: { staged?: boolean }, skipConfirm = false) => {
			if (!filepath) return false;
			if (!skipConfirm) {
				const confirmed = await showConfirm(appState, `Are you sure you want to discard changes in '${filepath}'? This action cannot be undone.`);
				if (!confirmed) return false;
			}
			const repo = appState.workspace.repository;
			if (repo?.adapter.discardChanges) {
				return await runGitOp(`Failed to discard changes in '${filepath}'`, async (r) => {
					await r.adapter.discardChanges!(filepath, options);
				});
			}
			return false;
		}
	});

	appState.commands.register({
		id: 'git.commit',
		label: 'Git: Commit',
		category: 'Source Control',
		action: async (message: string, options?: { author?: { name: string; email: string }; amend?: boolean }) => {
			const repo = appState.workspace.repository;
			if (!repo || !repo.adapter.commit) return false;

			const stagedCount = repo.changes.filter(c => c.staged).length;
			if (stagedCount === 0 && !options?.amend) {
				await showAlert(appState, 'Cannot commit: No staged changes to commit.');
				return false;
			}

			return await runGitOp('Commit', async (r) => {
				await r.adapter.commit!(message, options);
			});
		}
	});

	appState.commands.register({
		id: 'git.createBranch',
		label: 'Git: Create Branch',
		category: 'Source Control',
		action: async (branchName: string) => {
			if (!branchName) return false;
			const repo = appState.workspace.repository;
			if (repo?.adapter.createBranch) {
				return await runGitOp(`Failed to create branch '${branchName}'`, async (r) => {
					await r.adapter.createBranch!(branchName);
				});
			}
			return false;
		}
	});

	appState.commands.register({
		id: 'git.stageAll',
		label: 'Git: Stage All Changes',
		category: 'Source Control',
		action: async () => {
			const repo = appState.workspace.repository;
			if (!repo?.adapter.stageAll) return false;
			try {
				return await repo.stageAll();
			} catch (e) {
				console.error('Failed to stage all changes', e);
				await showAlert(appState, `Failed to stage all changes: ${(e as Error).message}`);
				return false;
			}
		}
	});

	appState.commands.register({
		id: 'git.unstageAll',
		label: 'Git: Unstage All Changes',
		category: 'Source Control',
		action: async () => {
			const repo = appState.workspace.repository;
			if (!repo?.adapter.unstageAll) return false;
			try {
				return await repo.unstageAll();
			} catch (e) {
				console.error('Failed to unstage all changes', e);
				await showAlert(appState, `Failed to unstage all changes: ${(e as Error).message}`);
				return false;
			}
		}
	});

	appState.commands.register({
		id: 'git.discardAll',
		label: 'Git: Discard All Changes',
		category: 'Source Control',
		action: async () => {
			const confirmed = await showConfirm(appState, 'Are you sure you want to discard ALL uncommitted changes? This action cannot be undone.');
			if (!confirmed) return false;

			const repo = appState.workspace.repository;
			if (!repo?.adapter.discardAll) return false;
			try {
				return await repo.discardAll();
			} catch (e) {
				console.error('Failed to discard all changes', e);
				await showAlert(appState, `Failed to discard all changes: ${(e as Error).message}`);
				return false;
			}
		}
	});

	appState.commands.register({
		id: 'git.openDiff',
		label: 'Git: Open Uncommitted Changes',
		category: 'Source Control',
		action: (filepath?: string) => {
			const ws = appState.workspace;
			const id = '__project_diff__';
			const existing = ws.tabs.find(t => t.id === id);
			if (!existing) {
				ws.tabs.push({ id, type: 'diff' });
			}
			ws.activeTabId = id;
			if (ws.repository) {
				ws.repository.setActiveDiffFileByPath(filepath);
			}
		}
	});


	appState.commands.register({
		id: 'git.nextHunk',
		label: 'Git: Next Hunk',
		category: 'Source Control',
		action: () => {
			appState.activeDiffNavigator?.nextHunk();
		},
		isEnabled: () => !!appState.activeDiffNavigator
	});

	appState.commands.register({
		id: 'git.prevHunk',
		label: 'Git: Previous Hunk',
		category: 'Source Control',
		action: () => {
			appState.activeDiffNavigator?.prevHunk();
		},
		isEnabled: () => !!appState.activeDiffNavigator
	});

	appState.commands.register({
		id: 'git.stageHunk',
		label: 'Git: Stage Hunk',
		category: 'Source Control',
		action: async (change: GitChange, hunk: HunkRange) => {
			await applyHunkAction(appState, change, hunk, 'stage');
		}
	});

	appState.commands.register({
		id: 'git.unstageHunk',
		label: 'Git: Unstage Hunk',
		category: 'Source Control',
		action: async (change: GitChange, hunk: HunkRange) => {
			await applyHunkAction(appState, change, hunk, 'unstage');
		}
	});

	appState.commands.register({
		id: 'git.discardHunk',
		label: 'Git: Discard Hunk',
		category: 'Source Control',
		action: async (change: GitChange, hunk: HunkRange) => {
			await applyHunkAction(appState, change, hunk, 'discard');
		}
	});
}

export interface HunkRange {
	fromA: number;
	toA: number;
	fromB: number;
	toB: number;
}

/**
 * Maps a character position in document A (original text) to document B (modified text)
 * using diff chunks. If posA falls inside a changed chunk, it maps to the start of chunk B (fromB).
 * If posA is outside changed chunks, it offsets posA relative to preceding chunk boundaries.
 */
export function mapPos(posA: number, chunks: readonly Chunk[]): number {
	let lastToA = 0;
	let lastToB = 0;
	for (const c of chunks) {
		if (posA <= c.fromA) {
			return lastToB + (posA - lastToA);
		}
		// Strictly less-than: posA === c.toA sits on the unchanged boundary after
		// the chunk and must map to c.toB via the unchanged-region arithmetic
		// below, not to the chunk start.
		if (posA < c.toA) {
			return c.fromB;
		}
		lastToA = c.toA;
		lastToB = c.toB;
	}
	return lastToB + (posA - lastToA);
}

/**
 * Maps a character range [posFrom, posTo] defined on textA (original coordinate space)
 * into textB (target coordinate space) by computing diff chunks and mapping both endpoints.
 */
export function mapRange(
	posFrom: number,
	posTo: number,
	textA: Text,
	textB: Text
): { from: number; to: number } {
	const chunks = Chunk.build(textA, textB, DEFAULT_DIFF_CONFIG);
	return {
		from: mapPos(posFrom, chunks),
		to: mapPos(posTo, chunks)
	};
}

/**
 * Replaces a character slice [from, to] in the target Text document with the replacement string.
 */
export function spliceText(target: Text, from: number, to: number, replacement: string): string {
	return target.sliceString(0, from) + replacement + target.sliceString(to);
}

/**
 * Restores the reference content's CRLF line endings onto spliced output.
 * Text-based diff math normalizes to LF; without this, any hunk operation
 * on a CRLF file rewrites every line ending and dirties the whole file.
 */
function applyLineEndings(content: string, reference: string): string {
	if (!reference.includes('\r\n')) return content;
	return content.replace(/(?<!\r)\n/g, '\r\n');
}

/**
 * Splices [from, to] in the target Text document and restores the endings of
 * `reference`, the raw file content whose bytes the result will overwrite.
 * Index writes pass the index content as reference, worktree writes the
 * worktree content. Pairing them at one call site keeps that rule unmissable.
 */
function splicePreservingEndings(target: Text, from: number, to: number, replacement: string, reference: string): string {
	return applyLineEndings(spliceText(target, from, to, replacement), reference);
}

/**
 * Writes a discarded hunk's new worktree content; if that write fails,
 * restores the index to `stagedText` before rethrowing, so a half-applied
 * discard never leaves index and worktree describing different versions of
 * the file. Callers must have already verified both adapter methods exist.
 */
async function updateFileWithIndexRollback(
	repo: NonNullable<AppState['workspace']['repository']>,
	filepath: string,
	newWorktreeContent: string,
	stagedText: Text,
	stagedContent: string
): Promise<void> {
	try {
		await repo.adapter.updateFileContent!(filepath, newWorktreeContent);
	} catch (err) {
		try {
			await repo.adapter.updateIndexContent!(filepath, applyLineEndings(stagedText.toString(), stagedContent));
		} catch (rollbackErr) {
			console.error('Failed to rollback index after worktree write failure:', rollbackErr);
		}
		throw err;
	}
}

export async function applyHunkAction(
	appState: AppState,
	change: GitChange,
	hunk: HunkRange,
	action: 'stage' | 'unstage' | 'discard'
) {
	const repo = appState.workspace.repository;
	if (!repo) return;

	await runExclusively(repo, () => performHunkAction(appState, repo, change, hunk, action));
}

async function performHunkAction(
	appState: AppState,
	repo: NonNullable<AppState['workspace']['repository']>,
	change: GitChange,
	hunk: HunkRange,
	action: 'stage' | 'unstage' | 'discard'
) {
	try {
		if (action === 'stage' || action === 'unstage') {
			if (!repo.adapter.updateIndexContent) {
				throw new Error(`VCS adapter does not support updating index for hunk ${action}`);
			}
		} else if (action === 'discard') {
			if (!repo.adapter.updateFileContent) {
				throw new Error('VCS adapter does not support updating file content for hunk discard');
			}
		}

		let origContent = change.originalContent;
		let modContent = change.modifiedContent;
		let stagedContent = change.stagedContent;

		if (typeof origContent !== 'string' || typeof modContent !== 'string') {
			const diff = await repo.getFileDiff(change.filepath, change.combined ? undefined : { staged: change.staged });
			if (diff) {
				origContent = diff.originalContent;
				modContent = diff.modifiedContent;
				if (diff.stagedContent !== undefined) {
					stagedContent = diff.stagedContent;
				}
			}
		}

		if (typeof origContent !== 'string' || typeof modContent !== 'string') {
			throw new Error(`Cannot perform hunk ${action}: missing diff content for ${change.filepath}`);
		}

		if (stagedContent === undefined) {
			if (change.combined) {
				throw new Error(`Cannot perform hunk ${action}: combined change for ${change.filepath} is missing staged content`);
			}
			stagedContent = change.staged ? modContent : origContent;
		}

		const origText = Text.of(origContent.split(/\r?\n/));
		const modText = Text.of(modContent.split(/\r?\n/));
		const stagedText = Text.of(stagedContent.split(/\r?\n/));
		if (action === 'stage') {
			const indexRange = mapRange(hunk.fromA, hunk.toA, origText, stagedText);
			const newIndexContent = splicePreservingEndings(stagedText, indexRange.from, indexRange.to, modText.sliceString(hunk.fromB, hunk.toB), stagedContent);

			await repo.adapter.updateIndexContent!(change.filepath, newIndexContent);
		} else if (action === 'unstage') {
			const indexRange = mapRange(hunk.fromB, hunk.toB, modText, stagedText);
			const newIndexContent = splicePreservingEndings(stagedText, indexRange.from, indexRange.to, origText.sliceString(hunk.fromA, hunk.toA), stagedContent);

			await repo.adapter.updateIndexContent!(change.filepath, newIndexContent);
		} else if (action === 'discard') {
			const origHunkSlice = origText.sliceString(hunk.fromA, hunk.toA);

			if (change.staged && !change.combined) {
				// Staged-scope hunks live in HEAD-vs-index space (modText is the
				// index), so discarding must also revert the hunk's mirror image
				// in the worktree. Resolve the real worktree text first: writing
				// a splice of the index over the worktree would destroy
				// unrelated unstaged edits.
				if (!repo.adapter.updateIndexContent) {
					throw new Error('VCS adapter does not support updating index for hunk discard');
				}
				const wtDiff = await repo.getFileDiff(change.filepath, { staged: false });
				const wtContent = wtDiff?.modifiedContent;

				const indexRange = mapRange(hunk.fromB, hunk.toB, modText, stagedText);
				const newIndexContent = splicePreservingEndings(stagedText, indexRange.from, indexRange.to, origHunkSlice, stagedContent);

				if (typeof wtContent !== 'string') {
					// Worktree text unavailable: revert the index only. The
					// discarded hunk resurfaces as an unstaged change instead of
					// guessing at worktree bytes that were never read.
					await repo.adapter.updateIndexContent(change.filepath, newIndexContent);
				} else {
					const wtText = Text.of(wtContent.split(/\r?\n/));
					const unstagedChunks = Chunk.build(stagedText, wtText, DEFAULT_DIFF_CONFIG);
					const wtRange = mapRange(hunk.fromB, hunk.toB, stagedText, wtText);
					const wtStartLine = wtText.lineAt(Math.min(wtRange.from, wtText.length)).number;
					const wtEndLine = wtText.lineAt(Math.min(wtRange.to, wtText.length)).number;
					// Unstaged edits inside the hunk's region cannot be reverted
					// without destroying them; leave the worktree untouched so
					// they survive as an unstaged change.
					const overlapsUnstaged = unstagedChunks.some((uc: Chunk) => {
						const ucStartLine = wtText.lineAt(Math.min(uc.fromB, wtText.length)).number;
						const ucEndLine = wtText.lineAt(Math.min(uc.toB, wtText.length)).number;
						return wtStartLine <= ucEndLine && wtEndLine >= ucStartLine;
					});

					await repo.adapter.updateIndexContent(change.filepath, newIndexContent);

					if (!overlapsUnstaged) {
						const newWorktreeContent = splicePreservingEndings(wtText, wtRange.from, wtRange.to, origHunkSlice, wtContent);
						await updateFileWithIndexRollback(repo, change.filepath, newWorktreeContent, stagedText, stagedContent);
					}
				}
			} else {
				const unstagedChunks = Chunk.build(stagedText, modText, DEFAULT_DIFF_CONFIG);
				const lineStartB = modText.lineAt(Math.min(hunk.fromB, modText.length)).number;
				const lineEndB = modText.lineAt(Math.min(hunk.toB, modText.length)).number;
				const isUnstaged = unstagedChunks.some((uc: Chunk) => {
					const ucStartB = modText.lineAt(Math.min(uc.fromB, modText.length)).number;
					const ucEndB = modText.lineAt(Math.min(uc.toB, modText.length)).number;
					return (lineStartB <= ucEndB && lineEndB >= ucStartB);
				});

				if (isUnstaged) {
					const indexRange = mapRange(hunk.fromA, hunk.toA, origText, stagedText);
					const newWorktreeContent = splicePreservingEndings(modText, hunk.fromB, hunk.toB, stagedText.sliceString(indexRange.from, indexRange.to), modContent);

					await repo.adapter.updateFileContent!(change.filepath, newWorktreeContent);
				} else {
					if (!repo.adapter.updateIndexContent) {
						throw new Error('VCS adapter does not support updating index for hunk discard');
					}
					const indexRange = mapRange(hunk.fromB, hunk.toB, modText, stagedText);
					const newIndexContent = splicePreservingEndings(stagedText, indexRange.from, indexRange.to, origHunkSlice, stagedContent);
					const newWorktreeContent = splicePreservingEndings(modText, hunk.fromB, hunk.toB, origHunkSlice, modContent);

					await repo.adapter.updateIndexContent(change.filepath, newIndexContent);
					if (repo.adapter.updateFileContent) {
						await updateFileWithIndexRollback(repo, change.filepath, newWorktreeContent, stagedText, stagedContent);
					}
				}
			}
		}
		await repo.refresh();
	} catch (e) {
		console.error(`Failed to ${action} hunk:`, e);
		await showAlert(appState, `Failed to ${action} hunk in '${change.filepath}': ${(e as Error).message}`);
	}
}
