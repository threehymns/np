import { undo, redo, selectAll } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import type { AppState } from "./state.svelte";
import { transformer } from "./transformer";
import { allLanguages } from "./editor/language.svelte";
import { parseURI, toURI, type FileOrigin } from "./storage";
import type { GitChange } from "./project/vcs";

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

	appState.commands.register({
		id: 'file.open',
		label: 'Open...',
		category: 'File',
		action: () => { appState.openFile(); }
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
				const { from, to } = view.state.selection.main;
				if (from !== to) {
					const text = view.state.doc.sliceString(from, to);
					try {
						await writeClipboard(appState, text);
						view.dispatch({
							changes: { from, to, insert: "" },
							selection: { anchor: from }
						});
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
			
			if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
				try {
					const handle = await (window as any).showSaveFilePicker({
						suggestedName: appState.activeDocument.fileName.replace(/\.md$/, '') + '.html',
						types: [{ description: 'HTML Files', accept: { 'text/html': ['.html'] } }]
					});
					const writable = await handle.createWritable();
					await writable.write(html);
					await writable.close();
				} catch (e) {
					if ((e as Error).name !== 'AbortError') console.error(e);
				}
			} else if (typeof document !== 'undefined') {
				// Fallback to data URI download
				const blob = new Blob([html], { type: 'text/html' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = appState.activeDocument.fileName.replace(/\.md$/, '') + '.html';
				a.click();
				URL.revokeObjectURL(url);
			}
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
		repo.isBusy = true;
		try {
			await op(repo);
			await repo.refresh();
			return true;
		} catch (e) {
			console.error(`${label} failed:`, e);
			await showAlert(appState, `${label} failed: ${(e as Error).message}`);
			return false;
		} finally {
			repo.isBusy = false;
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
		action: async (filepath: string, skipConfirm = false) => {
			if (!filepath) return false;
			if (!skipConfirm) {
				const confirmed = await showConfirm(appState, `Are you sure you want to discard changes in '${filepath}'? This action cannot be undone.`);
				if (!confirmed) return false;
			}
			const repo = appState.workspace.repository;
			if (repo?.adapter.discardChanges) {
				return await runGitOp(`Failed to discard changes in '${filepath}'`, async (r) => {
					await r.adapter.discardChanges!(filepath);
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
			if (repo?.adapter.stageFile) {
				return await runGitOp('Failed to stage all changes', async (r) => {
					const unstaged = r.changes.filter(c => !c.staged);
					for (const u of unstaged) {
						await r.adapter.stageFile!(u.filepath);
					}
				});
			}
			return false;
		}
	});

	appState.commands.register({
		id: 'git.unstageAll',
		label: 'Git: Unstage All Changes',
		category: 'Source Control',
		action: async () => {
			const repo = appState.workspace.repository;
			if (repo?.adapter.unstageFile) {
				return await runGitOp('Failed to unstage all changes', async (r) => {
					const staged = r.changes.filter(c => c.staged);
					for (const s of staged) {
						await r.adapter.unstageFile!(s.filepath);
					}
				});
			}
			return false;
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
			if (repo?.adapter.discardChanges) {
				return await runGitOp('Failed to discard all changes', async (r) => {
					if (r.adapter.unstageFile) {
						const staged = r.changes.filter(c => c.staged);
						for (const s of staged) {
							await r.adapter.unstageFile(s.filepath);
						}
					}
					const paths = [...new Set(r.changes.map(c => c.filepath))];
					for (const filepath of paths) {
						await r.adapter.discardChanges!(filepath);
					}
				});
			}
			return false;
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
			if (filepath && ws.repository) {
				const change = ws.repository.changes.find(c => c.filepath === filepath);
				if (change) {
					ws.repository.activeDiffFile = change;
				}
			}
		}
	});

	const openPathAction = async (target: string | FileOrigin) => {
		if (!target) return;
		if (typeof target !== 'string') {
			await appState.workspace.openFile(target);
			return;
		}
		if (target.includes('://')) {
			await appState.workspace.openFile(parseURI(target));
		} else if (appState.workspace.rootOrigin) {
			const rootUri = toURI(appState.workspace.rootOrigin);
			const fileUri = `${rootUri.replace(/\/$/, '')}/${target.replace(/^\//, '')}`;
			await appState.workspace.openFile(parseURI(fileUri));
		} else {
			const isAbsolute = target.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(target) || target.startsWith('\\\\');
			if (isAbsolute) {
				const name = target.split(/[/\\]/).filter(Boolean).pop() || target;
				await appState.workspace.openFile({
					scheme: 'file',
					path: target,
					name
				});
			} else {
				return;
			}
		}
	};

	appState.commands.register({
		id: 'file.openPath',
		label: 'File: Open Path',
		category: 'File',
		action: openPathAction
	});

	appState.commands.register({
		id: 'editor.open',
		label: 'File: Open Path (Deprecated)',
		category: 'File',
		action: openPathAction
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
		if (posA <= c.toA) {
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
export function mapRange(posFrom: number, posTo: number, textA: Text, textB: Text): { from: number; to: number } {
	const chunks = Chunk.build(textA, textB);
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

export async function applyHunkAction(
	appState: AppState,
	change: GitChange,
	hunk: HunkRange,
	action: 'stage' | 'unstage' | 'discard'
) {
	const repo = appState.workspace.repository;
	if (!repo) return;

	repo.isBusy = true;
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
			stagedContent = change.staged ? modContent : origContent;
		}

		const origText = Text.of(origContent.split(/\r?\n/));
		const modText = Text.of(modContent.split(/\r?\n/));
		const stagedText = Text.of(stagedContent.split(/\r?\n/));
		if (action === 'stage') {
			const indexRange = mapRange(hunk.fromA, hunk.toA, origText, stagedText);
			const newIndexContent = spliceText(stagedText, indexRange.from, indexRange.to, modText.sliceString(hunk.fromB, hunk.toB));

			if (repo.adapter.updateIndexContent) {
				await repo.adapter.updateIndexContent(change.filepath, newIndexContent);
			}
		} else if (action === 'unstage') {
			const indexRange = mapRange(hunk.fromB, hunk.toB, modText, stagedText);
			const newIndexContent = spliceText(stagedText, indexRange.from, indexRange.to, origText.sliceString(hunk.fromA, hunk.toA));

			if (repo.adapter.updateIndexContent) {
				await repo.adapter.updateIndexContent(change.filepath, newIndexContent);
			}
		} else if (action === 'discard') {
			const unstagedChunks = Chunk.build(stagedText, modText);
			const lineStartB = modText.lineAt(Math.min(hunk.fromB, modText.length)).number;
			const lineEndB = modText.lineAt(Math.min(hunk.toB, modText.length)).number;
			const isUnstaged = unstagedChunks.some((uc: Chunk) => {
				const ucStartB = modText.lineAt(Math.min(uc.fromB, modText.length)).number;
				const ucEndB = modText.lineAt(Math.min(uc.toB, modText.length)).number;
				return (lineStartB <= ucEndB && lineEndB >= ucStartB);
			});

			if (isUnstaged) {
				const indexRange = mapRange(hunk.fromA, hunk.toA, origText, stagedText);
				const newWorktreeContent = spliceText(modText, hunk.fromB, hunk.toB, stagedText.sliceString(indexRange.from, indexRange.to));

				if (repo.adapter.updateFileContent) {
					await repo.adapter.updateFileContent(change.filepath, newWorktreeContent);
				}
			} else {
				if (!repo.adapter.updateIndexContent) {
					throw new Error('VCS adapter does not support updating index for hunk discard');
				}
				const indexRange = mapRange(hunk.fromB, hunk.toB, modText, stagedText);
				const origHunkSlice = origText.sliceString(hunk.fromA, hunk.toA);
				const newIndexContent = spliceText(stagedText, indexRange.from, indexRange.to, origHunkSlice);
				const newWorktreeContent = spliceText(modText, hunk.fromB, hunk.toB, origHunkSlice);

				await repo.adapter.updateIndexContent(change.filepath, newIndexContent);
				if (repo.adapter.updateFileContent) {
					await repo.adapter.updateFileContent(change.filepath, newWorktreeContent);
				}
			}
		}
		await repo.refresh();
	} catch (e) {
		console.error(`Failed to ${action} hunk:`, e);
		await showAlert(appState, `Failed to ${action} hunk in '${change.filepath}': ${(e as Error).message}`);
	} finally {
		repo.isBusy = false;
	}
}
