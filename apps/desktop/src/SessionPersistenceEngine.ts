import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';

export interface SessionPersistenceOptions {
	getFilePath: () => string;
	debounceMs?: number;
}

export class SessionPersistenceEngine {
	private getFilePath: () => string;
	private debounceMs: number;
	private persistenceData: Record<string, any> | null = null;
	private loadPromise: Promise<Record<string, any>> | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private isDirty = false;
	private saveGeneration = 0;
	private committedGeneration = 0;
	private writeCoordinator: Promise<void> = Promise.resolve();

	constructor(options: SessionPersistenceOptions) {
		this.getFilePath = options.getFilePath;
		this.debounceMs = options.debounceMs ?? 500;
	}

	/**
	 * Returns the in-memory cache if already loaded, or loads it from disk on first call.
	 */
	public async getPersistenceData(): Promise<Record<string, any>> {
		if (this.persistenceData !== null) {
			return this.persistenceData;
		}

		if (this.loadPromise !== null) {
			return this.loadPromise;
		}

		this.loadPromise = (async () => {
			const filePath = this.getFilePath();
			try {
				const content = await fs.readFile(filePath, 'utf-8');
				const parsed = JSON.parse(content);
				if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
					this.persistenceData = parsed;
				} else {
					this.persistenceData = {};
				}
			} catch {
				this.persistenceData = {};
			} finally {
				this.loadPromise = null;
			}
			return this.persistenceData ?? {};
		})();

		return this.loadPromise;
	}

	/**
	 * Updates the in-memory cache synchronously (if loaded) and schedules a debounced disk write.
	 */
	public async save(key: string, value: any): Promise<void> {
		const data = await this.getPersistenceData();
		data[key] = value;
		this.isDirty = true;
		this.saveGeneration++;
		this.scheduleDebouncedWrite();
	}

	/**
	 * Loads a value from the in-memory session cache (falling back to disk on cold start).
	 */
	public async load(key: string): Promise<any> {
		const data = await this.getPersistenceData();
		return data[key] ?? null;
	}

	/**
	 * Loads the full dictionary from the in-memory session cache.
	 */
	public async loadAll(): Promise<Record<string, any>> {
		const data = await this.getPersistenceData();
		return { ...data };
	}

	/**
	 * Schedules a debounced disk write.
	 */
	private scheduleDebouncedWrite(): void {
		if (this.debounceTimer !== null) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.writeToDisk().catch((err) => {
				console.error('Failed to write persistence file:', err);
			});
		}, this.debounceMs);
	}

	/**
	 * Writes dirty in-memory data to disk asynchronously.
	 */
	public async writeToDisk(): Promise<void> {
		if (!this.isDirty || this.persistenceData === null) {
			return;
		}

		const targetGen = this.saveGeneration;
		const filePath = this.getFilePath();
		const serialized = JSON.stringify(this.persistenceData, null, 2);
		const dir = path.dirname(filePath);

		const task = async () => {
			if (targetGen <= this.committedGeneration) {
				return;
			}

			await fs.mkdir(dir, { recursive: true });
			const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

			try {
				await fs.writeFile(tempPath, serialized, 'utf-8');
				if (targetGen > this.committedGeneration) {
					await fs.rename(tempPath, filePath);
					this.committedGeneration = targetGen;
					if (this.saveGeneration === targetGen) {
						this.isDirty = false;
					}
				} else {
					await fs.unlink(tempPath).catch(() => {});
				}
			} catch (err) {
				await fs.unlink(tempPath).catch(() => {});
				this.isDirty = true;
				console.error('Failed to write persistence file:', err);
				throw err;
			}
		};

		const nextPromise = this.writeCoordinator.catch(() => {}).then(task);
		this.writeCoordinator = nextPromise.catch(() => {});
		return nextPromise;
	}

	/**
	 * Asynchronously flushes any pending debounced writes immediately.
	 */
	public async flush(): Promise<void> {
		if (this.debounceTimer !== null) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		if (!this.isDirty || this.persistenceData === null) {
			return;
		}

		await this.writeToDisk();
	}

	/**
	 * Cancels any active debounce timer and immediately flushes dirty in-memory data
	 * to disk synchronously. Used during application teardown (before-quit).
	 */
	public flushSync(): void {
		if (this.debounceTimer !== null) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		if (!this.isDirty || this.persistenceData === null) {
			return;
		}

		const currentGen = this.saveGeneration;
		if (currentGen <= this.committedGeneration) {
			return;
		}

		const filePath = this.getFilePath();
		const dir = path.dirname(filePath);
		const serialized = JSON.stringify(this.persistenceData, null, 2);
		const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

		try {
			fsSync.mkdirSync(dir, { recursive: true });
			fsSync.writeFileSync(tempPath, serialized, 'utf-8');
			if (currentGen > this.committedGeneration) {
				fsSync.renameSync(tempPath, filePath);
				this.committedGeneration = currentGen;
				if (this.saveGeneration === currentGen) {
					this.isDirty = false;
				}
			} else {
				try {
					fsSync.unlinkSync(tempPath);
				} catch {}
			}
		} catch (err) {
			try {
				fsSync.unlinkSync(tempPath);
			} catch {}
			console.error('Failed to flush persistence file synchronously on quit:', err);
		}
	}

	// Helpers for testing / inspection
	public getInMemoryCache(): Record<string, any> | null {
		return this.persistenceData;
	}

	public hasPendingWrite(): boolean {
		return this.debounceTimer !== null;
	}

	public isDirtyState(): boolean {
		return this.isDirty;
	}
}
