import type { PreferenceStorage } from '@np/core';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';

/**
 * PreferenceStorage implementation for the Electron desktop environment.
 * Persists application preferences to config.json with comment-preserving CST delta edits.
 */
export class ElectronConfigStorage implements PreferenceStorage {
	private cachedText: string = '';
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
		parse(text, errors);
		if (errors.length > 0) {
			console.error('config.json contains syntax errors; falling back to in-memory defaults', errors);
			this.hasSyntaxError = true;
			return false;
		}
		this.hasSyntaxError = false;
		return true;
	}

	getItem(key: string): string | null {
		if (this.hasSyntaxError || !this.cachedText) {
			return null;
		}

		try {
			const errors: ParseError[] = [];
			const parsed = parse(this.cachedText, errors);
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
			const edits = modify(currentText, [propKey], propVal, {
				formattingOptions: {
					insertSpaces: true,
					tabSize: 2
				}
			});
			currentText = applyEdits(currentText, edits);
		}

		// Identical-write suppression: skip write if content hasn't changed
		if (currentText === this.cachedText) {
			return;
		}

		this.cachedText = currentText;
		window.electronAPI.writeConfigFile(currentText).catch((err) => {
			console.error('Failed to persist config.json:', err);
		});
	}

	/**
	 * Helper exposed for testing or external reloading.
	 */
	getRawContent(): string {
		return this.cachedText;
	}
}
