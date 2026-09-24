import { undo, redo, selectAll } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import type { AppState } from "./state.svelte";

import { transformer } from "./transformer";
import { allLanguages } from "./editor/language.svelte";
import { parseURI, toURI, type FileOrigin } from "./storage";
import { DEFAULT_DIFF_CONFIG } from "./project/vcs";
import {
	CORE_COMMANDS_OWNER,
	createAddCommandsTransform,
	rebuildCommands,
	type CommandTransform,
	type CommandTransformEntry,
	type PluginCommand
} from "./plugins/commands";

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
	return target.startsWith('/') || /^[a-zA-Z]:[/\\\\]/.test(target) || target.startsWith('\\\\');
}

export type Command = PluginCommand;

export class CommandRegistry {
	private transforms: CommandTransformEntry[] = [];
	private commandMap = $state<Map<string, Command>>(new Map());

	/**
	 * Contributes a transform to the shared registry and rebuilds by
	 * replaying all transforms in order from an empty initial value
	 * (ADR 0012). Transforms must be pure and repeatable.
	 */
	registerTransform(pluginId: string, transform: CommandTransform) {
		this.transforms.push({ pluginId, transform });
		this.rebuild();
	}

	/**
	 * Convenience for the common additive case: contributes commands that
	 * are appended to the accumulated state during replay.
	 */
	registerCommands(pluginId: string, commands: readonly Command[]) {
		this.registerTransform(pluginId, createAddCommandsTransform(commands));
	}

	/**
	 * Drops one owner's transforms and rebuilds without them
	 * (Reactivation). Used by tests and the plugin host disposal path.
	 */
	removePlugin(pluginId: string) {
		const kept = this.transforms.filter((entry) => entry.pluginId !== pluginId);
		if (kept.length !== this.transforms.length) {
			this.transforms = kept;
			this.rebuild();
		}
	}

	/**
	 * Replays current transforms from an empty initial value.
	 * Idempotent: the same transform list always yields the same registry,
	 * so refresh-mid-session rebuilds produce no duplicates or losses.
	 */
	rebuild() {
		this.commandMap = rebuildCommands(this.transforms);
	}

	/** Reload alias for rebuild (CONTEXT.md Reload terminology). */
	refresh() {
		this.rebuild();
	}

	get(id: string) {
		return this.commandMap.get(id);
	}

	getAll() {
		return Array.from(this.commandMap.values());
	}

	getByCategory(category: string) {
		return this.getAll().filter(c => c.category === category);
	}

	execute(id: string, ...args: any[]) {
		const command = this.get(id);
		if (command && (!command.isEnabled || command.isEnabled())) {
			return command.action(...args);
		}
	}
}

function getDocText(doc: any): string {
	if (typeof doc.toString === 'function') {
		return doc.toString();
	}
	const len = typeof doc.length === 'number' ? doc.length : 0;
	if (typeof doc.sliceString === 'function') {
		return doc.sliceString(0, len);
	}
	return '';
}

function getSelectionRange(view: any): { from: number; to: number; empty: boolean } {
	const sel = view.state?.selection?.main || { from: 0, to: 0, empty: true };
	const from = sel.from ?? 0;
	const to = sel.to ?? from;
	const empty = sel.empty !== undefined ? sel.empty : (from === to);
	return { from, to, empty };
}

function toggleInlineFormat(
	appState: AppState,
	open: string,
	close: string = open
) {
	if (!appState.activeEditorView) return;
	const view = appState.activeEditorView;
	const { from, to, empty } = getSelectionRange(view);
	const doc = view.state.doc;
	const docLength = typeof doc.length === 'number' ? doc.length : (doc.toString ? doc.toString().length : 0);

	if (empty) {
		const before = doc.sliceString(Math.max(0, from - open.length), from);
		const after = doc.sliceString(from, Math.min(docLength, from + close.length));
		if (before === open && after === close) {
			view.dispatch({
				changes: { from: from - open.length, to: from + close.length, insert: '' },
				selection: { anchor: from - open.length }
			});
		} else {
			view.dispatch({
				changes: { from, insert: `${open}${close}` },
				selection: { anchor: from + open.length }
			});
		}
	} else {
		const text = doc.sliceString(from, to);
		if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
			const inner = text.slice(open.length, text.length - close.length);
			view.dispatch({
				changes: { from, to, insert: inner },
				selection: { anchor: from, head: from + inner.length }
			});
		} else {
			const before = doc.sliceString(Math.max(0, from - open.length), from);
			const after = doc.sliceString(to, Math.min(docLength, to + close.length));
			if (before === open && after === close) {
				view.dispatch({
					changes: { from: from - open.length, to: to + close.length, insert: text },
					selection: { anchor: from - open.length, head: to - open.length }
				});
			} else {
				view.dispatch({
					changes: { from, to, insert: `${open}${text}${close}` },
					selection: { anchor: from + open.length, head: to + open.length }
				});
			}
		}
	}
	view.focus();
}

function toggleHeading(appState: AppState, level: number) {
	if (!appState.activeEditorView) return;
	const view = appState.activeEditorView;
	const { from, to, empty } = getSelectionRange(view);
	const doc = view.state.doc;
	const docText = getDocText(doc);

	const lineStart = docText.lastIndexOf('\n', Math.max(0, from - 1)) === -1 ? 0 : docText.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
	const nextNewline = docText.indexOf('\n', to);
	const lineEnd = nextNewline === -1 ? docText.length : nextNewline;

	const block = docText.slice(lineStart, lineEnd);
	const lines = block.split('\n');
	const prefix = '#'.repeat(level) + ' ';

	const allHaveHeading = lines.every(l => l.startsWith(prefix));

	const transformedLines = lines.map(line => {
		if (allHaveHeading) {
			return line.slice(prefix.length);
		}
		const headingMatch = line.match(/^#{1,6}\s+/);
		if (headingMatch) {
			return prefix + line.slice(headingMatch[0].length);
		}
		return prefix + line;
	});

	const newBlock = transformedLines.join('\n');
	view.dispatch({
		changes: { from: lineStart, to: lineEnd, insert: newBlock },
		selection: empty
			? { anchor: lineStart + newBlock.length }
			: { anchor: lineStart, head: lineStart + newBlock.length }
	});
	view.focus();
}

function toggleList(appState: AppState, type: 'bullet' | 'numbered' | 'task') {
	if (!appState.activeEditorView) return;
	const view = appState.activeEditorView;
	const { from, to, empty } = getSelectionRange(view);
	const doc = view.state.doc;
	const docText = getDocText(doc);

	const lineStart = docText.lastIndexOf('\n', Math.max(0, from - 1)) === -1 ? 0 : docText.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
	const nextNewline = docText.indexOf('\n', to);
	const lineEnd = nextNewline === -1 ? docText.length : nextNewline;

	const block = docText.slice(lineStart, lineEnd);
	const lines = block.split('\n');

	let transformedLines: string[];

	if (type === 'bullet') {
		const allBullet = lines.every(l => /^[-*+]\s+/.test(l));
		transformedLines = lines.map(line => {
			if (allBullet) {
				return line.replace(/^[-*+]\s+/, '');
			}
			return '- ' + line.replace(/^(\d+\.|[-*+](\s+\[[ xX]\])?)\s+/, '');
		});
	} else if (type === 'numbered') {
		const allNumbered = lines.every(l => /^\d+\.\s+/.test(l));
		transformedLines = lines.map((line, i) => {
			if (allNumbered) {
				return line.replace(/^\d+\.\s+/, '');
			}
			const cleaned = line.replace(/^(\d+\.|[-*+](\s+\[[ xX]\])?)\s+/, '');
			return `${i + 1}. ${cleaned}`;
		});
	} else if (type === 'task') {
		const allTask = lines.every(l => /^[-*+]\s+\[[ xX]\]\s+/.test(l));
		transformedLines = lines.map(line => {
			if (allTask) {
				return line.replace(/^[-*+]\s+\[[ xX]\]\s+/, '');
			}
			const cleaned = line.replace(/^(\d+\.|[-*+](\s+\[[ xX]\])?)\s+/, '');
			return `- [ ] ${cleaned}`;
		});
	} else {
		transformedLines = lines;
	}

	const newBlock = transformedLines.join('\n');
	view.dispatch({
		changes: { from: lineStart, to: lineEnd, insert: newBlock },
		selection: empty
			? { anchor: lineStart + newBlock.length }
			: { anchor: lineStart, head: lineStart + newBlock.length }
	});
	view.focus();
}

function toggleBlockquote(appState: AppState) {
	if (!appState.activeEditorView) return;
	const view = appState.activeEditorView;
	const { from, to, empty } = getSelectionRange(view);
	const doc = view.state.doc;
	const docText = getDocText(doc);

	const lineStart = docText.lastIndexOf('\n', Math.max(0, from - 1)) === -1 ? 0 : docText.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
	const nextNewline = docText.indexOf('\n', to);
	const lineEnd = nextNewline === -1 ? docText.length : nextNewline;

	const block = docText.slice(lineStart, lineEnd);
	const lines = block.split('\n');

	const allQuote = lines.every(l => /^>\s?/.test(l));
	const transformedLines = lines.map(line => {
		if (allQuote) {
			return line.replace(/^>\s?/, '');
		}
		return `> ${line}`;
	});

	const newBlock = transformedLines.join('\n');
	view.dispatch({
		changes: { from: lineStart, to: lineEnd, insert: newBlock },
		selection: empty
			? { anchor: lineStart + newBlock.length }
			: { anchor: lineStart, head: lineStart + newBlock.length }
	});
	view.focus();
}

function insertCodeBlock(appState: AppState) {
	if (!appState.activeEditorView) return;
	const view = appState.activeEditorView;
	const { from, to, empty } = getSelectionRange(view);
	const doc = view.state.doc;

	if (empty) {
		view.dispatch({
			changes: { from, insert: '```\n\n```' },
			selection: { anchor: from + 4 }
		});
	} else {
		const text = doc.sliceString(from, to);
		view.dispatch({
			changes: { from, to, insert: `\`\`\`\n${text}\n\`\`\`` },
			selection: { anchor: from + 4, head: from + 4 + text.length }
		});
	}
	view.focus();
}

function insertBlockMath(appState: AppState) {
	if (!appState.activeEditorView) return;
	const view = appState.activeEditorView;
	const { from, to, empty } = getSelectionRange(view);
	const doc = view.state.doc;

	if (empty) {
		view.dispatch({
			changes: { from, insert: '$$\n\n$$' },
			selection: { anchor: from + 3 }
		});
	} else {
		const text = doc.sliceString(from, to);
		view.dispatch({
			changes: { from, to, insert: `$$\n${text}\n$$` },
			selection: { anchor: from + 3, head: from + 3 + text.length }
		});
	}
	view.focus();
}

function insertCallout(appState: AppState) {
	if (!appState.activeEditorView) return;
	const view = appState.activeEditorView;
	const { from, to, empty } = getSelectionRange(view);
	const doc = view.state.doc;

	if (empty) {
		view.dispatch({
			changes: { from, insert: '> [!note]\n> ' },
			selection: { anchor: from + 12 }
		});
	} else {
		const text = doc.sliceString(from, to);
		const quotedText = text.split('\n').map((l: string) => `> ${l}`).join('\n');
		view.dispatch({
			changes: { from, to, insert: `> [!note]\n${quotedText}` },
			selection: { anchor: from + 10, head: from + 10 + quotedText.length }
		});
	}
	view.focus();
}

function insertHorizontalRule(appState: AppState) {
	if (!appState.activeEditorView) return;
	const view = appState.activeEditorView;
	const { from, to } = getSelectionRange(view);
	const doc = view.state.doc;
	const docText = getDocText(doc);

	const needsLeadingNewline = from > 0 && docText[from - 1] !== '\n';
	const needsTrailingNewline = to < docText.length && docText[to] !== '\n';
	const insertText = (needsLeadingNewline ? '\n' : '') + '---' + (needsTrailingNewline ? '\n' : '\n');

	view.dispatch({
		changes: { from, to, insert: insertText },
		selection: { anchor: from + insertText.length }
	});
	view.focus();
}

function insertTable(appState: AppState) {
	if (!appState.activeEditorView) return;
	const view = appState.activeEditorView;
	const { from, to } = getSelectionRange(view);
	const tableText = '| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |\n';

	view.dispatch({
		changes: { from, to, insert: tableText },
		selection: { anchor: from + 2 }
	});
	view.focus();
}

function toggleLinkFormat(appState: AppState) {
	if (!appState.activeEditorView) return;
	const view = appState.activeEditorView;
	const { from, to, empty } = getSelectionRange(view);
	const doc = view.state.doc;

	if (empty) {
		view.dispatch({
			changes: { from, insert: '[](url)' },
			selection: { anchor: from + 1 }
		});
	} else {
		const text = doc.sliceString(from, to);
		if (/^https?:\/\//i.test(text.trim())) {
			view.dispatch({
				changes: { from, to, insert: `[](${text.trim()})` },
				selection: { anchor: from + 1 }
			});
		} else {
			view.dispatch({
				changes: { from, to, insert: `[${text}](url)` },
				selection: { anchor: from + text.length + 3, head: from + text.length + 6 }
			});
		}
	}
	view.focus();
}

function toggleFootnoteFormat(appState: AppState) {
	if (!appState.activeEditorView) return;
	const view = appState.activeEditorView;
	const { from, to, empty } = getSelectionRange(view);
	const doc = view.state.doc;

	if (empty) {
		view.dispatch({
			changes: { from, insert: '[^1]' },
			selection: { anchor: from + 3, head: from + 4 }
		});
	} else {
		const text = doc.sliceString(from, to);
		view.dispatch({
			changes: { from, to, insert: `[^${text}]` },
			selection: { anchor: from + 2, head: to + 2 }
		});
	}
	view.focus();
}

// Core command contributions, registered as one replayable transform (ADR 0012).
// The host replays registered transforms in order from an empty initial value
// on every rebuild; removing a plugin rebuilds without its commands and a
// refresh replays the same transforms with no duplicates or losses.
// Feature sections below push their commands where they are implemented;
// Git commands live in the Git plugin's modules (#202) and register under
// the 'git' owner when that plugin is enabled.
export function registerCoreCommands(appState: AppState) {
	const coreCommands: Command[] = [];
	coreCommands.push({
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
			const name = target.split(/[/\\\\]/).filter(Boolean).pop() || target;
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

	coreCommands.push({
		id: 'file.open',
		label: 'Open...',
		category: 'File',
		action: openFileAction
	});

	coreCommands.push({
		id: 'file.openFolder',
		label: 'Open Folder...',
		category: 'File',
		action: () => appState.workspace.openDirectory()
	});

	coreCommands.push({
		id: 'file.save',
		label: 'Save',
		category: 'File',
		action: () => appState.saveFile()
	});

	coreCommands.push({
		id: 'file.saveAs',
		label: 'Save As...',
		category: 'File',
		action: () => appState.saveFileAs()
	});

	coreCommands.push({
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

	coreCommands.push({
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

	coreCommands.push({
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

	coreCommands.push({
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

	coreCommands.push({
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

	coreCommands.push({
		id: 'edit.find',
		label: 'Find...',
		category: 'Edit',
		action: () => appState.activeEditorView && openSearchPanel(appState.activeEditorView),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
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

	coreCommands.push({
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

	coreCommands.push({
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

	coreCommands.push({
		id: 'transformer.exportHTML',
		label: 'Export to HTML...',
		category: 'Export',
		action: async () => {
			if (!appState.activeDocument) return;
			if (!appState.exportService?.exportFile) {
				await showAlert(appState, 'Export service is unavailable');
				return;
			}
			const html = await transformer.transform(appState.activeDocument.content, 'html');
			const suggestedName = appState.activeDocument.fileName.replace(/\.md$/, '') + '.html';

			try {
				await appState.exportService.exportFile({
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

  coreCommands.push({
    id: 'commandPalette.toggle',
    label: 'Command Palette: Toggle',
    category: 'View',
    action: () => {
      appState.commandPalette.open = !appState.commandPalette.open;
    }
  });

	coreCommands.push({
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

	coreCommands.push({
		id: 'view.toggleSidebar',
		label: 'Toggle Sidebar',
		category: 'View',
		action: () => {
			appState.prefs.sidebarVisible = !appState.prefs.sidebarVisible;
		}
	});

	coreCommands.push({
		id: 'view.zoomIn',
		label: 'Zoom In',
		category: 'View',
		action: () => appState.prefs.zoomIn()
	});

	coreCommands.push({
		id: 'view.zoomOut',
		label: 'Zoom Out',
		category: 'View',
		action: () => appState.prefs.zoomOut()
	});

	coreCommands.push({
		id: 'view.zoomReset',
		label: 'Restore Default Zoom',
		category: 'View',
		action: () => appState.prefs.resetZoom()
	});

	coreCommands.push({
		id: 'view.toggleStatusBar',
		label: 'Status Bar',
		category: 'View',
		action: () => {
			appState.prefs.statusBar = !appState.prefs.statusBar;
		}
	});

	// Generic diff/hunk navigation (non-plugin core commands). The mounted
	// diff view publishes its navigator on AppState regardless of which
	// plugins are enabled, so these survive with all optional plugins
	// disabled and keep working for any present or future diff provider.
	// Only Git-mutating hunk ops (stage/unstage/discard) live in the Git
	// plugin; pure navigation belongs to the basic editor.
	coreCommands.push({
		id: 'diff.nextHunk',
		label: 'Next Hunk',
		category: 'Go',
		action: () => {
			appState.activeDiffNavigator?.nextHunk();
		},
		isEnabled: () => !!appState.activeDiffNavigator
	});

	coreCommands.push({
		id: 'diff.prevHunk',
		label: 'Previous Hunk',
		category: 'Go',
		action: () => {
			appState.activeDiffNavigator?.prevHunk();
		},
		isEnabled: () => !!appState.activeDiffNavigator
	});

	coreCommands.push({
		id: 'format.toggleWordWrap',
		label: 'Word Wrap',
		category: 'Format',
		action: () => {
			appState.prefs.wordWrap = !appState.prefs.wordWrap;
		}
	});

	// Markdown formatting commands
	coreCommands.push({
		id: 'format.bold',
		label: 'Bold',
		category: 'Format',
		action: () => toggleInlineFormat(appState, '**'),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.italic',
		label: 'Italic',
		category: 'Format',
		action: () => toggleInlineFormat(appState, '*'),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.strikethrough',
		label: 'Strikethrough',
		category: 'Format',
		action: () => toggleInlineFormat(appState, '~~'),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.highlight',
		label: 'Highlight',
		category: 'Format',
		action: () => toggleInlineFormat(appState, '=='),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.code',
		label: 'Inline Code',
		category: 'Format',
		action: () => toggleInlineFormat(appState, '`'),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.codeBlock',
		label: 'Code Block',
		category: 'Format',
		action: () => insertCodeBlock(appState),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.heading1',
		label: 'Heading 1',
		category: 'Format',
		action: () => toggleHeading(appState, 1),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.heading2',
		label: 'Heading 2',
		category: 'Format',
		action: () => toggleHeading(appState, 2),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.heading3',
		label: 'Heading 3',
		category: 'Format',
		action: () => toggleHeading(appState, 3),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.heading4',
		label: 'Heading 4',
		category: 'Format',
		action: () => toggleHeading(appState, 4),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.heading5',
		label: 'Heading 5',
		category: 'Format',
		action: () => toggleHeading(appState, 5),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.heading6',
		label: 'Heading 6',
		category: 'Format',
		action: () => toggleHeading(appState, 6),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.bulletList',
		label: 'Bullet List',
		category: 'Format',
		action: () => toggleList(appState, 'bullet'),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.numberedList',
		label: 'Numbered List',
		category: 'Format',
		action: () => toggleList(appState, 'numbered'),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.taskList',
		label: 'Task List',
		category: 'Format',
		action: () => toggleList(appState, 'task'),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.blockquote',
		label: 'Blockquote',
		category: 'Format',
		action: () => toggleBlockquote(appState),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.callout',
		label: 'Callout',
		category: 'Format',
		action: () => insertCallout(appState),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.horizontalRule',
		label: 'Horizontal Rule',
		category: 'Format',
		action: () => insertHorizontalRule(appState),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.table',
		label: 'Table',
		category: 'Format',
		action: () => insertTable(appState),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.insertTable',
		label: 'Insert Table',
		category: 'Format',
		action: () => insertTable(appState),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.inlineMath',
		label: 'Inline Math',
		category: 'Format',
		action: () => toggleInlineFormat(appState, '$'),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.blockMath',
		label: 'Block Math',
		category: 'Format',
		action: () => insertBlockMath(appState),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.footnote',
		label: 'Footnote',
		category: 'Format',
		action: () => toggleFootnoteFormat(appState),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.comment',
		label: 'Comment',
		category: 'Format',
		action: () => toggleInlineFormat(appState, '%%'),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
		id: 'format.link',
		label: 'Add Link',
		category: 'Format',
		action: () => toggleLinkFormat(appState),
		isEnabled: () => !!appState.activeEditorView
	});

	coreCommands.push({
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

	coreCommands.push({
		id: 'settings.open',
		label: 'Preferences: Open Settings',
		category: 'Preferences',
		action: () => {
			appState.settingsOpen = true;
		}
	});

	coreCommands.push({
		id: 'settings.openConfigJson',
		label: 'Preferences: Open Settings (JSON)',
		category: 'Preferences',
		action: async () => {
			if (typeof window !== 'undefined' && (window as any).electronAPI?.getConfigPath) {
				try {
					const configPath = await (window as any).electronAPI.getConfigPath();
					if (configPath) {
						const name = configPath.split(/[/\\\\]/).filter(Boolean).pop() || 'config.json';
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

	coreCommands.push({
		id: 'keybindings.open',
		label: 'Preferences: Open Keymaps (JSON)',
		category: 'Preferences',
		action: () => {
			appState.workspace.openFile(parseURI('keymap://user/keymap.json'));
			appState.settingsOpen = false;
		}
	});

	appState.commands.registerCommands(CORE_COMMANDS_OWNER, coreCommands);	appState.commands.registerCommands(CORE_COMMANDS_OWNER, coreCommands);
}

// HunkRange now lives with the Git commands that consume it (#202);
// kept here as a type-only re-export so existing import sites keep working.
export type { HunkRange } from './plugins/git/commands';

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
