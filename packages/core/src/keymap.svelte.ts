import { ContextPredicate, type Predicate } from './context.svelte';
import type { AppState } from './state.svelte';
import type { StorageProvider, FileOrigin, StorageEntry } from './storage';

export interface Keystroke {
	key: string;      // Normalized key name
	ctrl: boolean;     // Ctrl key modifier
	meta: boolean;     // Cmd (Mac) / Windows key modifier
	alt: boolean;      // Alt/Option modifier
	shift: boolean;    // Shift modifier
}

export interface KeymapBinding {
	context?: string;
	bindings: Record<string, string>; // e.g., "space f n" -> "file.new"
}

export interface ParsedBinding {
	contextExpr?: string;
	parsedContext?: Predicate;
	rawSequence: string;
	sequence: Keystroke[];
	commandId: string;
}

export const defaultKeymap: KeymapBinding[] = [
	{
		context: "editor && vim_mode == normal",
		bindings: {
			"space f n": "file.new",
			"space f o": "file.open",
			"space f s": "file.save",
			"space f a": "file.saveAs",
			"space e u": "edit.undo",
			"space e r": "edit.redo",
			"space e x": "edit.cut",
			"space e y": "edit.copy",
			"space e p": "edit.paste",
			"space e f": "edit.find",
			"space e a": "edit.selectAll",
			"space e l": "edit.changeLanguageMode",
			// Hunk navigation mirrors Zed's vim-mode `]c` / `[c`
			"] c": "git.nextHunk",
			"[ c": "git.prevHunk",
			"space v s": "view.toggleSidebar",
			"space p": "commandPalette.toggle",
			"space d": "window.toggleDevTools"
		}
	},
	{
		context: "editor",
		bindings: {
			"cmd+z": "edit.undo",
			"cmd+shift+z": "edit.redo",
			"cmd+x": "edit.cut",
			"cmd+c": "edit.copy",
			"cmd+v": "edit.paste",
			"cmd+f": "edit.find",
			"cmd+a": "edit.selectAll",
			"cmd+k m": "edit.changeLanguageMode",
			// Hunk navigation mirrors Zed's editor `cmd+f8` / `cmd+shift+f8`
			"cmd+f8": "git.nextHunk",
			"cmd+shift+f8": "git.prevHunk"
		}
	},
	{
		// Global bindings
		bindings: {
			"cmd+n": "file.new",
			"cmd+o": "file.open",
			"cmd+s": "file.save",
			"cmd+shift+s": "file.saveAs",
			"cmd+shift+p": "commandPalette.toggle",
			"cmd+\\": "view.toggleSidebar",
			"cmd++": "view.zoomIn",
			"cmd+-": "view.zoomOut",
			"cmd+0": "view.zoomReset",
			"cmd+,": "settings.open",
			"cmd+shift+,": "settings.openConfigJson",
			"cmd+alt+i": "window.toggleDevTools",
			"ctrl+shift+i": "window.toggleDevTools",
			"cmd+f8": "git.nextHunk",
			"cmd+shift+f8": "git.prevHunk"
		}
	}
];

export function formatShortcutLabel(sequence: string): string {
	const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
	return sequence.split(/\s+/).map(chord => {
		return chord
			.replace(/cmd\+|meta\+/g, isMac ? '⌘' : 'Ctrl+')
			.replace(/ctrl\+/g, isMac ? '⌃' : 'Ctrl+')
			.replace(/alt\+/g, isMac ? '⌥' : 'Alt+')
			.replace(/shift\+/g, isMac ? '⇧' : 'Shift+')
			.toUpperCase();
	}).join(' ');
}

export function parseKeySequence(sequence: string): Keystroke[] {
	const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;

	return sequence.trim().split(/\s+/).map(keystrokeStr => {
		let ctrl = false;
		let meta = false;
		let alt = false;
		let shift = false;

		const normalized = keystrokeStr.toLowerCase();
		let parts: string[];
		if (normalized.includes('+')) {
			parts = normalized.split('+');
		} else {
			parts = normalized.split('-');
		}

		let key = parts[parts.length - 1];
		if (key === '' && keystrokeStr.endsWith('+')) {
			key = '+';
		} else if (key === '' && keystrokeStr.endsWith('-')) {
			key = '-';
		}

		const modifiers = parts.slice(0, -1);
		for (const mod of modifiers) {
			if (mod === 'ctrl' || mod === 'control') ctrl = true;
			if (mod === 'cmd' || mod === 'meta' || mod === 'super') {
				if (isMac) meta = true;
				else ctrl = true; // Normalize Cmd to Ctrl on Linux/Windows
			}
			if (mod === 'alt' || mod === 'option') alt = true;
			if (mod === 'shift') shift = true;
		}

		if (key === 'space') key = ' ';
		if (key === 'esc') key = 'escape';
		if (key === 'up') key = 'arrowup';
		if (key === 'down') key = 'arrowdown';
		if (key === 'left') key = 'arrowleft';
		if (key === 'right') key = 'arrowright';
		if (key === 'enter' || key === 'cr') key = 'enter';

		return { key, ctrl, meta, alt, shift };
	});
}

export function keystrokesEqual(a: Keystroke, b: Keystroke): boolean {
	return (
		a.key.toLowerCase() === b.key.toLowerCase() &&
		a.ctrl === b.ctrl &&
		a.meta === b.meta &&
		a.alt === b.alt &&
		a.shift === b.shift
	);
}

export function keystrokeStartsWith(sequence: Keystroke[], prefix: Keystroke[]): boolean {
	if (prefix.length > sequence.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (!keystrokesEqual(sequence[i], prefix[i])) return false;
	}
	return true;
}

export class KeymapRegistry {
	private appState: AppState;
	
	// Active context states (reactive)
	context = $state<Record<string, string | boolean>>({
		true: true // Always true helper
	});
	
	// Currently pressed keystrokes buffer (reactive)
	keyBuffer = $state<Keystroke[]>([]);
	
	// Loaded bindings list
	bindings = $state<ParsedBinding[]>([]);
	
	constructor(appState: AppState) {
		this.appState = appState;
		this.loadBindings(defaultKeymap);
		
		// Load user keymap asynchronously on startup
		this.readUserKeymap().then(content => {
			this.reloadUserKeymap(content);
		}).catch(err => {
			console.error('Failed to load user keymap on startup:', err);
		});
	}
	
	setContext(key: string, value: string | boolean | undefined) {
		if (value === undefined) {
			delete this.context[key];
		} else {
			this.context[key] = value;
		}
	}
	
	loadBindings(keymap: KeymapBinding[]) {
		const parsed: ParsedBinding[] = [];
		for (const binding of keymap) {
			const parsedContext = binding.context ? ContextPredicate.parse(binding.context) : undefined;
			for (const [seqStr, cmdId] of Object.entries(binding.bindings)) {
				parsed.push({
					contextExpr: binding.context,
					parsedContext,
					rawSequence: seqStr,
					sequence: parseKeySequence(seqStr),
					commandId: cmdId
				});
			}
		}
		this.bindings = parsed;
	}
	
	// Get all bindings that match the current context
	getActiveBindings(): ParsedBinding[] {
		return this.bindings.filter(b => {
			if (!b.parsedContext) return true;
			return ContextPredicate.eval(b.parsedContext, this.context);
		});
	}

	// Helper for UI to show a shortcut for a command
	getShortcutForCommand(commandId: string): string | undefined {
		// Prefer the most specific binding (last one in the list that matches context)
		// Or just find the first one for now as a simple implementation
		const active = this.getActiveBindings();
		const match = active.reverse().find(b => b.commandId === commandId);
		if (match) {
			return formatShortcutLabel(match.rawSequence);
		}
		return undefined;
	}
	
	// Matches a physical key event into a canonical keystroke object
	private getKeystrokeFromEvent(e: KeyboardEvent): Keystroke {
		const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
		
		let key = e.key.toLowerCase();
		if (key === ' ') key = ' '; // Keep space normalized as space character
		
		// If it's a modifier key by itself, return empty key
		const isModOnly = ['control', 'shift', 'alt', 'meta'].includes(key);
		
		// On Windows/Linux, meta is Windows key, ctrl is Control.
		// On macOS, meta is Command, ctrl is Control.
		return {
			key: isModOnly ? '' : key,
			ctrl: e.ctrlKey,
			meta: e.metaKey,
			alt: e.altKey,
			shift: e.shiftKey
		};
	}
	
	handleKeydown(e: KeyboardEvent): boolean {
		console.log('handleKeydown', e.key, (e.target as HTMLElement).tagName);
		// Ignore if target is a standard input field or textarea, 
		// but only for plain character keys (to allow Cmd+S etc.)
		const target = e.target as HTMLElement;
		const isStandardInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
		const hasModifier = e.ctrlKey || e.metaKey || e.altKey;

		if (isStandardInput && !hasModifier) {
			return false;
		}

		// Ignore if target is just a modifier key
		if (['control', 'shift', 'alt', 'meta'].includes(e.key.toLowerCase())) {
			return false;
		}

		// Also let Escape pass if there's no active buffer
		if (e.key === 'Escape' && this.keyBuffer.length === 0) {
			return false;
		}

		// Handle active buffer clearing via Esc
		if (e.key === 'Escape' && this.keyBuffer.length > 0) {
			e.preventDefault();
			e.stopPropagation();
			this.keyBuffer = [];
			return true;
		}

		// Handle Backspace navigation inside chords
		if (e.key === 'Backspace' && this.keyBuffer.length > 0) {
			e.preventDefault();
			e.stopPropagation();
			this.keyBuffer.pop();
			return true;
		}

		const keystroke = this.getKeystrokeFromEvent(e);
		if (!keystroke.key) return false;

		const candidate = [...this.keyBuffer, keystroke];
		const activeBindings = this.getActiveBindings();

		// Check for matches
		let hasPartial = false;
		let fullMatch: ParsedBinding | null = null;

		for (const binding of activeBindings) {
			if (keystrokeStartsWith(binding.sequence, candidate)) {
				if (binding.sequence.length === candidate.length) {
					fullMatch = binding;
				} else {
					hasPartial = true;
				}
			}
		}

		if (fullMatch && !hasPartial) {
			e.preventDefault();
			e.stopPropagation();
			this.keyBuffer = [];
			this.appState.commands.execute(fullMatch.commandId);
			return true;
		}

		if (hasPartial) {
			e.preventDefault();
			e.stopPropagation();
			this.keyBuffer = candidate;
			return true;
		}

		// If we were in a chord, but hit an invalid key, cancel the chord
		if (this.keyBuffer.length > 0) {
			e.preventDefault();
			e.stopPropagation();
			this.keyBuffer = [];
			return true;
		}

		return false;
	}

	async readUserKeymap(): Promise<string> {
		if (typeof window !== 'undefined' && (window as any).electronAPI?.readFileUserKeymap) {
			try {
				const content = await (window as any).electronAPI.readFileUserKeymap();
				if (content) return content;
			} catch (e) {
				console.error('Failed to read user keymap via IPC:', e);
			}
		} else if (typeof window !== 'undefined') {
			const content = window.localStorage.getItem('np-keymap');
			if (content) return content;
		}
		// Return empty keymap if not found
		return '[]';
	}

	async saveUserKeymap(content: string): Promise<void> {
		if (typeof window !== 'undefined' && (window as any).electronAPI?.writeFileUserKeymap) {
			try {
				await (window as any).electronAPI.writeFileUserKeymap(content);
			} catch (e) {
				console.error('Failed to write user keymap via IPC:', e);
			}
		} else if (typeof window !== 'undefined') {
			window.localStorage.setItem('np-keymap', content);
		}
		this.reloadUserKeymap(content);
	}

	async setCustomKeybinding(commandId: string, shortcutStr: string) {
		const content = await this.readUserKeymap();
		try {
			// Clean up potential trailing commas before parsing
			const cleaned = content.replace(/,[ \t\r\n]*([}\\]])/g, '$1');
			let userKeymap = JSON.parse(cleaned);
			
			if (!Array.isArray(userKeymap)) {
				userKeymap = [];
			}

			let block = userKeymap.find((b: any) => !b.context);
			if (!block) {
				block = { bindings: {} };
				userKeymap.push(block);
			}
			block.bindings[shortcutStr] = commandId;
			await this.saveUserKeymap(JSON.stringify(userKeymap, null, 2));
		} catch (e) {
			console.error('Failed to save custom keybinding:', e);
			// If parsing failed, start fresh
			const userKeymap = [{ bindings: { [shortcutStr]: commandId } }];
			await this.saveUserKeymap(JSON.stringify(userKeymap, null, 2));
		}
	}

	reloadUserKeymap(content: string) {
		if (!content || !content.trim()) return;
		try {
			// Basic cleanup to handle trailing commas
			const cleaned = content.replace(/,[ \t\r\n]*([}\\]])/g, '$1');
			const userKeymap = JSON.parse(cleaned);
			if (Array.isArray(userKeymap)) {
				this.loadBindings([...defaultKeymap, ...userKeymap]);
			}
		} catch (e) {
			console.error('Failed to parse user keymap:', e);
		}
	}
}

export class KeymapStorageProvider implements StorageProvider {
	scheme = 'keymap';
	private keymaps: KeymapRegistry;

	constructor(keymaps: KeymapRegistry) {
		this.keymaps = keymaps;
	}

	async pickFile(): Promise<FileOrigin | null> { return null; }
	async pickDirectory(): Promise<FileOrigin | null> { return null; }

	async saveFile(content: string, existingOrigin?: FileOrigin): Promise<FileOrigin | null> {
		const origin = existingOrigin ?? { scheme: this.scheme, path: 'user/keymap.json', name: 'keymap.json' };
		await this.keymaps.saveUserKeymap(content);
		return origin;
	}

	async readFile(origin: FileOrigin): Promise<string> {
		return await this.keymaps.readUserKeymap();
	}

	async readDirectory(origin: FileOrigin): Promise<StorageEntry[]> { return []; }
	async verifyPermission(origin: FileOrigin, readWrite?: boolean): Promise<boolean> { return true; }
	async queryPermission(origin: FileOrigin, readWrite?: boolean): Promise<'granted' | 'prompt' | 'denied'> { return 'granted'; }
	async createFile(parent: FileOrigin, name: string): Promise<FileOrigin> { return parent; }
	async createDirectory(parent: FileOrigin, name: string): Promise<FileOrigin> { return parent; }
	async deleteEntry(origin: FileOrigin): Promise<void> {}
	async renameEntry(origin: FileOrigin, newName: string): Promise<FileOrigin> { return origin; }
}
