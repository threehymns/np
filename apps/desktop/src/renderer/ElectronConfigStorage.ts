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

	private writeQueue: Promise<void> = Promise.resolve();
	private writeGeneration = 0;

	/**
	 * Whole-document legacy key: the user settings document lives flat in
	 * config.json (zoom, theme, editor/ui/git namespaces, ...). Every other
	 * PreferenceStorage key (e.g. np-plugin-enablement-v1) is isolated under
	 * its own top-level property so a plugin id can never collide with a
	 * settings namespace of the same name (F1: "git" boolean vs object).
	 */
	private static readonly SETTINGS_DOC_KEY = 'np-prefs-v2';

	/**
	 * Isolated top-level properties: every PreferenceStorage key that is not
	 * the settings document. They are owned by a single writer
	 * (Preferences, `PLUGIN_ENABLEMENT_KEY`), so the settings document neither
	 * reads them nor writes them back — a settings payload is a snapshot, and
	 * replaying it would revert whatever the owner wrote since.
	 */
	private static readonly ISOLATED_KEYS: ReadonlySet<string> = new Set(['np-plugin-enablement-v1']);

	/**
	 * The settings document as seen by its owner: the whole config.json minus
	 * the isolated properties, which stay invisible to the settings payload.
	 */
	private settingsDocument(parsed: Record<string, any>): Record<string, any> {
		const doc: Record<string, any> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (!ElectronConfigStorage.ISOLATED_KEYS.has(key)) {
				doc[key] = value;
			}
		}
		return doc;
	}

	private readDoc(): Record<string, any> | null {
		const text = this.pendingText ?? this.cachedText;
		if (this.hasSyntaxError || !text) {
			return null;
		}

		try {
			const errors: ParseError[] = [];
			const parsed = parse(text, errors, { allowTrailingComma: true });
			if (errors.length > 0 || !parsed || typeof parsed !== 'object') {
				return null;
			}
			return parsed as Record<string, any>;
		} catch {
			return null;
		}
	}

	private applySingleKeyEdit(currentText: string, propKey: string, propVal: unknown): string {
		if (this.shouldInsertBeforeTrailingComment(currentText, propKey)) {
			return this.insertBeforeTrailingComment(currentText, propKey, propVal);
		}
		const edits = modify(currentText, [propKey], propVal, {
			formattingOptions: {
				insertSpaces: true,
				tabSize: 2
			}
		});
		return applyEdits(currentText, edits);
	}

	getItem(key: string): string | null {
		const parsed = this.readDoc();
		if (!parsed) {
			return null;
		}

		if (key === ElectronConfigStorage.SETTINGS_DOC_KEY) {
			return JSON.stringify(this.settingsDocument(parsed));
		}

		if (!(key in parsed)) {
			return null;
		}
		return JSON.stringify((parsed as Record<string, unknown>)[key]);
	}

	setItem(key: string, value: string): void {
		if (this.hasSyntaxError) {
			console.warn('Skipping config.json write because file contains syntax errors.');
			return;
		}

		if (typeof window === 'undefined' || !window.electronAPI?.writeConfigFile) {
			return;
		}

		let parsedValue: unknown;
		try {
			parsedValue = JSON.parse(value);
		} catch (e) {
			console.error('Failed to parse preference payload for writing:', e);
			return;
		}

		// Apply CST modifications onto the latest known text (pending or cached)
		let baseText = this.pendingText ?? this.cachedText;
		let currentText = baseText.trim() ? baseText : '{\n}\n';

		if (key !== ElectronConfigStorage.SETTINGS_DOC_KEY) {
			// Isolated key: store the whole payload under its own top-level
			// property so it can never collide with a settings namespace.
			currentText = this.applySingleKeyEdit(currentText, key, parsedValue);
		} else {
			let newPrefs: Record<string, any>;
			if (parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)) {
				newPrefs = parsedValue as Record<string, any>;
			} else {
				console.error('Failed to parse preference payload for writing: expected object');
				return;
			}
			// Apply CST modifications for each key in newPrefs, skipping the
			// isolated properties: the payload is a snapshot, and writing one
			// back would revert the owner's current value.
			const settings = this.settingsDocument(newPrefs);
			for (const [propKey, propVal] of Object.entries(settings)) {
				currentText = this.applySingleKeyEdit(currentText, propKey, propVal);
			}
		}

		// Identical-write suppression: skip write if content hasn't changed
		// relative to the last confirmed persistence or an already-pending write.
		if (currentText === this.cachedText || currentText === this.pendingText) {
			return;
		}

		this.pendingText = currentText;
		const targetText = currentText;
		const generation = ++this.writeGeneration;

		this.writeQueue = this.writeQueue
			.then(async () => {
				if (typeof window === 'undefined' || !window.electronAPI?.writeConfigFile) {
					return;
				}
				await window.electronAPI.writeConfigFile(targetText);
				if (this.writeGeneration === generation) {
					this.cachedText = targetText;
				}
				if (this.pendingText === targetText) {
					this.pendingText = null;
				}
			})
			.catch((err) => {
				console.error('Failed to persist config.json:', err);
				if (this.writeGeneration === generation) {
					this.writeGeneration = generation - 1;
				}
				if (this.pendingText === targetText) {
					this.pendingText = null;
				}
			});
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
