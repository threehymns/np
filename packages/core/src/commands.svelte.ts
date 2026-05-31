import { undo, redo, selectAll } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import type { AppState } from "./state.svelte";
import { transformer } from "./transformer";
import { allLanguages } from "./editor/language.svelte";
import { parseURI } from "./storage";

export interface Command {
	id: string;
	label: string;
	category: string;
	action: () => void | Promise<void>;
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

	execute(id: string) {
		const command = this.get(id);
		if (command && (!command.isEnabled || command.isEnabled())) {
			command.action();
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
					await navigator.clipboard.writeText(text);
					view.dispatch({
						changes: { from, to, insert: "" },
						selection: { anchor: from }
					});
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
					await navigator.clipboard.writeText(text);
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
					const text = await navigator.clipboard.readText();
					view.dispatch(view.state.replaceSelection(text));
					view.focus();
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
			await navigator.clipboard.writeText(html);
		}
	});

	appState.commands.register({
		id: 'transformer.exportHTML',
		label: 'Export to HTML...',
		category: 'Export',
		action: async () => {
			if (!appState.activeDocument) return;
			const html = await transformer.transform(appState.activeDocument.content, 'html');
			
			if ('showSaveFilePicker' in window) {
				try {
					const handle = await window.showSaveFilePicker({
						suggestedName: appState.activeDocument.fileName.replace(/\.md$/, '') + '.html',
						types: [{ description: 'HTML Files', accept: { 'text/html': ['.html'] } }]
					});
					const writable = await handle.createWritable();
					await writable.write(html);
					await writable.close();
				} catch (e) {
					if ((e as Error).name !== 'AbortError') console.error(e);
				}
			} else {
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
}
