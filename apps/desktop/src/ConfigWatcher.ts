import fs from 'fs/promises';
import fsSync, { type FSWatcher } from 'fs';
import path from 'path';
import { parse, type ParseError } from 'jsonc-parser';

export interface ConfigWatcherOptions {
	configPath: string;
	onConfigChanged: (content: string) => void;
	debounceMs?: number;
}

export class ConfigWatcher {
	private configPath: string;
	private onConfigChanged: (content: string) => void;
	private debounceMs: number;
	private watcher: FSWatcher | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private lastWrittenContent: string | null = null;
	private generation = 0;
	private closed = false;

	constructor(options: ConfigWatcherOptions) {
		this.configPath = options.configPath;
		this.onConfigChanged = options.onConfigChanged;
		this.debounceMs = options.debounceMs ?? 100;
	}

	/**
	 * Inform the watcher that np itself is about to write this content,
	 * so external change detection can ignore this exact content and avoid circular loops.
	 */
	public setLastWrittenContent(content: string): void {
		this.lastWrittenContent = content;
	}

	public getLastWrittenContent(): string | null {
		return this.lastWrittenContent;
	}

	public start(): void {
		if (this.watcher || this.closed) return;

		const dir = path.dirname(this.configPath);
		const targetFile = path.basename(this.configPath);

		try {
			if (!fsSync.existsSync(dir)) {
				fsSync.mkdirSync(dir, { recursive: true });
			}
		} catch (e) {
			console.error('Failed to ensure config directory for watching:', e);
		}

		try {
			// Watch the directory rather than the file directly, so atomic renames/editor replacements don't stop the watcher
			this.watcher = fsSync.watch(dir, (eventType, filename) => {
				if (!filename || filename === targetFile) {
					this.handleFileChange();
				}
			});
		} catch (e) {
			console.error('Failed to start config watcher:', e);
		}
	}

	public handleFileChange(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(async () => {
			await this.processChange();
		}, this.debounceMs);
	}

	public async processChange(): Promise<void> {
		const generation = ++this.generation;
		let content: string;
		try {
			content = await fs.readFile(this.configPath, 'utf-8');
		} catch (e: any) {
			if (e?.code !== 'ENOENT') {
				console.error('Failed to read config.json on change:', e);
			}
			return;
		}

		// Discard results from an older generation that resolved after a newer
		// change started, so stale content is never broadcast after current content.
		if (generation !== this.generation) {
			return;
		}

		// Check if this matches our last programmatic write
		if (this.lastWrittenContent !== null && content === this.lastWrittenContent) {
			// Loop prevention: this event was caused by np writing the file
			this.lastWrittenContent = null;
			return;
		}

		// Reset lastWrittenContent if external content differs
		this.lastWrittenContent = null;

		// Validate JSONC syntax
		const errors: ParseError[] = [];
		parse(content, errors, { allowTrailingComma: true });
		if (errors.length > 0) {
			console.warn('External config.json change contains syntax errors; ignoring update.');
			return;
		}

		// Broadcast valid content
		this.onConfigChanged(content);
	}

	public close(): void {
		this.closed = true;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
	}
}
