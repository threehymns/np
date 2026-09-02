import type { PreferenceStorage } from '@np/core';
import { parse, modify, applyEdits, parseTree, type ParseError } from 'jsonc-parser';

/**
 * PreferenceStorage implementation for the Electron desktop environment.
 * Persists application preferences to config.json with comment-preserving CST delta edits.
 */
export class ElectronConfigStorage implements PreferenceStorage {
	private cachedText: string = '';
	private pendingText: string | null = null;
	private hasSyntaxError: boolean = false;

	constructor() {
		this.init();
	}

	private init(): void {
		if (typeof window === 'undefined' || !window.electronAPI?.readConfigFileSync) {
			return;
		}

		try {
			const content = window.electronAPI.readConfigFileSync();
			if (content !== null && content !== undefined) {
				this.cachedText = content;
				this.validateSyntax(content);
			}
		} catch (e) {
			console.error('Failed to read config file synchronously:', e);
		}
	}

	private validateSyntax(text: string): boolean {
		const errors: ParseError[] = [];
		parse(text, errors, { allowTrailingComma: true });
		if (errors.length > 0) {
			console.error('config.json contains syntax errors; falling back to in-memory defaults', errors);
			this.hasSyntaxError = true;
			return false;
		}
		this.hasSyntaxError = false;
		return true;
	}

	/**
	 * True when adding `key` would make jsonc-parser's append insert it before an
	 * inline trailing comment on the current last property, misattributing that
	 * comment. Only applies to keys not yet present in the document.
	 */
	private shouldInsertBeforeTrailingComment(text: string, key: string): boolean {
		const root = parseTree(text);
		if (!root || root.type !== 'object' || !root.children) return false;

		const props = root.children.filter((c) => c.type === 'property');
		const lastProp = props[props.length - 1];
		if (!lastProp) return false;

		// Already present: modify edits in place, so no misattribution risk.
		const existing = new Set(props.map((p) => p.children?.[0]?.value as string));
		if (existing.has(key)) return false;

		// Does the final property carry an inline comment on its own line?
		const lineTail = this.lineTailAfterNode(text, lastProp.offset + lastProp.length);
		return /\/\/|\/\*/.test(lineTail);
	}

	/**
	 * Insert a new property just before the current last property, keeping that
	 * property's inline trailing comment attached to it rather than to the new key.
	 */
	private insertBeforeTrailingComment(text: string, key: string, value: unknown): string {
		const root = parseTree(text)!;
		const props = root.children!.filter((c) => c.type === 'property');
		const lastProp = props[props.length - 1];

		const lineStart = text.lastIndexOf('\n', lastProp.offset - 1);
		const indent = lineStart >= 0 ? text.slice(lineStart + 1, lastProp.offset) : '';
		const insertion = `${JSON.stringify(key)}: ${JSON.stringify(value)},\n${indent}`;

		return text.slice(0, lastProp.offset) + insertion + text.slice(lastProp.offset);
	}

	private lineTailAfterNode(text: string, nodeEnd: number): string {
		const rest = text.slice(nodeEnd);
		const eol = rest.indexOf('\n');
		return eol === -1 ? rest : rest.slice(0, eol);
	}

	getItem(key: string): string | null {
		if (this.hasSyntaxError || !this.cachedText) {
			return null;
		}

		try {
			const errors: ParseError[] = [];
			const parsed = parse(this.cachedText, errors, { allowTrailingComma: true });
			if (errors.length > 0 || !parsed || typeof parsed !== 'object') {
				return null;
			}
			return JSON.stringify(parsed);
		} catch {
			return null;
		}
	}

	setItem(key: string, value: string): void {
		if (this.hasSyntaxError) {
			console.warn('Skipping config.json write because file contains syntax errors.');
			return;
		}

		if (typeof window === 'undefined' || !window.electronAPI?.writeConfigFile) {
			return;
		}

		let newPrefs: Record<string, any>;
		try {
			newPrefs = JSON.parse(value);
		} catch (e) {
			console.error('Failed to parse preference payload for writing:', e);
			return;
		}

		let currentText = this.cachedText.trim() ? this.cachedText : '{\n}\n';

		// Apply CST modifications for each key in newPrefs
		for (const [propKey, propVal] of Object.entries(newPrefs)) {
			if (this.shouldInsertBeforeTrailingComment(currentText, propKey)) {
				currentText = this.insertBeforeTrailingComment(currentText, propKey, propVal);
			} else {
				const edits = modify(currentText, [propKey], propVal, {
					formattingOptions: {
						insertSpaces: true,
						tabSize: 2
					}
				});
				currentText = applyEdits(currentText, edits);
			}
		}

		// Identical-write suppression: skip write if content hasn't changed
		// relative to the last confirmed persistence or an already-pending write.
		if (currentText === this.cachedText || currentText === this.pendingText) {
			return;
		}

		// Keep pending content separate from confirmed content so a failed write
		// does not mark uncommitted text as persisted (which would suppress retries
		// and let preferences revert after restart).
		this.pendingText = currentText;
		window.electronAPI.writeConfigFile(currentText).then(
			() => {
				this.cachedText = currentText;
				if (this.pendingText === currentText) this.pendingText = null;
			},
			(err) => {
				console.error('Failed to persist config.json:', err);
				if (this.pendingText === currentText) this.pendingText = null;
			}
		);
	}

	/**
	 * Update cached content from an external file change and validate syntax.
	 * Returns true if valid JSONC, false if syntax errors were found.
	 */
	updateFromExternal(newContent: string): boolean {
		this.cachedText = newContent;
		this.pendingText = null;
		return this.validateSyntax(newContent);
	}
}
