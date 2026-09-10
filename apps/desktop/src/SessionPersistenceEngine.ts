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
	 * Updates the in-memory cache and schedules a debounced disk write.
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
	 * Returns a deep clone so callers cannot mutate the live cache without going
	 * through save().
	 */
	public async load(key: string): Promise<any> {
		const data = await this.getPersistenceData();
		const value = data[key];
		return value === undefined ? null : structuredClone(value);
	}

	/**
	 * Loads the full dictionary from the in-memory session cache.
	 * Returns a deep clone so callers cannot mutate the live cache without going
	 * through save().
	 */
	public async loadAll(): Promise<Record<string, any>> {
		const data = await this.getPersistenceData();
		return structuredClone(data);
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

		const filePath = this.getFilePath();
		const dir = path.dirname(filePath);

		const task = async () => {
			// Capture the generation at execution time, not queue time, so a
			// save() between queueing and execution commits its own generation
			// with matching data instead of committing N while serializing
			// N+1 data (which would leave isDirty set and force an extra
			// debounced write of the same file).
			const targetGen = this.saveGeneration;
			if (targetGen <= this.committedGeneration) {
				return;
			}

			// Serialize at execution time, not queue time, so a save()
			// between queueing and execution doesn't commit stale data.
			const current = this.persistenceData;
			if (current === null) return;
			const serialized = JSON.stringify(current, null, 2);

			await fs.mkdir(dir, { recursive: true });
			const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

		try {
			await fs.writeFile(tempPath, serialized, 'utf-8');
			if (targetGen > this.committedGeneration) {
				await fs.rename(tempPath, filePath);
				if (targetGen >= this.committedGeneration) {
					this.committedGeneration = targetGen;
					if (this.saveGeneration === targetGen) {
						this.isDirty = false;
					}
				} else {
					// A synchronous flush committed a newer generation while our
					// rename was in flight, so this stale rename just clobbered
					// newer data. Rewrite the current in-memory state to repair
					// the file (see repairClobberedWrite).
					await this.repairClobberedWrite();
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
	 * Rewrites the current in-memory state after post-rename validation detected
	 * that a synchronous flush committed a newer generation while our rename was
	 * in flight (our rename then landed last and clobbered that newer data).
	 * Loops until a rename lands without concurrent interference; every pass
	 * writes the current state, so the file converges to the latest data.
	 * Runs inside the write-coordinator chain, so no other async write can
	 * interleave — only a synchronous flush can, and that restarts the loop.
	 */
	private async repairClobberedWrite(): Promise<void> {
		while (true) {
			const repairGen = this.saveGeneration;
			const current = this.persistenceData;
			if (current === null) return;
			const filePath = this.getFilePath();
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
			try {
				await fs.writeFile(tempPath, JSON.stringify(current, null, 2), 'utf-8');
				await fs.rename(tempPath, filePath);
			} catch (err) {
				await fs.unlink(tempPath).catch(() => {});
				throw err;
			}
			if (repairGen >= this.committedGeneration) {
				this.committedGeneration = repairGen;
				if (this.saveGeneration === repairGen) {
					this.isDirty = false;
				}
				return;
			}
			// A newer generation committed while our repair rename was in
			// flight; loop around and rewrite the (possibly newer) current state.
		}
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
