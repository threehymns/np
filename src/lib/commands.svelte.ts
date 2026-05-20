import { undo, redo, selectAll } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { appState } from "./state.svelte";
import { transformer } from "./transformer";

export interface Command {
	id: string;
	label: string;
	category: string;
	shortcut?: string;
	action: () => void | Promise<void>;
	isVisible?: () => boolean;
	isEnabled?: () => boolean;
}

class CommandRegistry {
	private commands = $state<Command[]>([]);

	register(command: Command) {
		this.commands.push(command);
	}

	get(id: string) {
		return this.commands.find(c => c.id === id);
	}

	getAll() {
		return this.commands;
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

	handleKeydown(e: KeyboardEvent) {
		const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
		const meta = isMac ? e.metaKey : e.ctrlKey;
		
		for (const command of this.commands) {
			if (!command.shortcut) continue;
			
			const parts = command.shortcut.toLowerCase().split('+');
			const key = parts.pop();
			const hasMeta = parts.includes('cmd') || parts.includes('ctrl');
			const hasShift = parts.includes('shift');
			const hasAlt = parts.includes('alt');

			if (
				e.key.toLowerCase() === key &&
				meta === hasMeta &&
				e.shiftKey === hasShift &&
				e.altKey === hasAlt
			) {
				if (!command.isEnabled || command.isEnabled()) {
					e.preventDefault();
					command.action();
					return true;
				}
			}
		}
		return false;
	}
}

export const commands = new CommandRegistry();

// Initial registration of core commands
export function registerCoreCommands() {
	commands.register({
		id: 'file.new',
		label: 'New',
		category: 'File',
		shortcut: 'cmd+n',
		action: () => appState.newFile()
	});

	commands.register({
		id: 'file.open',
		label: 'Open...',
		category: 'File',
		shortcut: 'cmd+o',
		action: () => appState.openFile()
	});

	commands.register({
		id: 'file.openFolder',
		label: 'Open Folder...',
		category: 'File',
		action: () => appState.workspace.openDirectory()
	});

	commands.register({
		id: 'file.save',
		label: 'Save',
		category: 'File',
		shortcut: 'cmd+s',
		action: () => appState.saveFile()
	});

	commands.register({
		id: 'file.saveAs',
		label: 'Save As...',
		category: 'File',
		action: () => appState.saveFileAs()
	});

	commands.register({
		id: 'edit.undo',
		label: 'Undo',
		category: 'Edit',
		shortcut: 'cmd+z',
		action: () => appState.activeEditorView && undo(appState.activeEditorView),
		isEnabled: () => !!appState.activeEditorView
	});

	commands.register({
		id: 'edit.redo',
		label: 'Redo',
		category: 'Edit',
		shortcut: 'shift+cmd+z',
		action: () => appState.activeEditorView && redo(appState.activeEditorView),
		isEnabled: () => !!appState.activeEditorView
	});

	commands.register({
		id: 'edit.find',
		label: 'Find...',
		category: 'Edit',
		shortcut: 'cmd+f',
		action: () => appState.activeEditorView && openSearchPanel(appState.activeEditorView),
		isEnabled: () => !!appState.activeEditorView
	});

	commands.register({
		id: 'edit.selectAll',
		label: 'Select All',
		category: 'Edit',
		shortcut: 'cmd+a',
		action: () => appState.activeEditorView && selectAll(appState.activeEditorView),
		isEnabled: () => !!appState.activeEditorView
	});

	commands.register({
		id: 'transformer.copyHTML',
		label: 'Copy as HTML',
		category: 'Export',
		action: async () => {
			if (!appState.activeDocument) return;
			const html = await transformer.transform(appState.activeDocument.content, 'html');
			await navigator.clipboard.writeText(html);
		}
	});

	commands.register({
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
}
