// installMockFS is passed directly to page.evaluate, so Playwright serializes
// just this function's source into the browser. It must stay self-contained:
// no imports, no references to anything outside the function body.
export function installMockFS() {
	class MockFileHandle {
		kind = 'file' as const;
		deleted = false;
		constructor(public name: string, public data: Uint8Array = new Uint8Array(), public mtime = Date.now()) {}
		async isSameEntry(other: any) { return this === other; }
		async queryPermission() { return 'granted' as const; }
		async getFile() {
			if (this.deleted) {
				const err = new Error('File not found');
				err.name = 'NotFoundError';
				throw err;
			}
			return new File([this.data as any], this.name, { lastModified: this.mtime });
		}
		async createWritable() {
			const self = this;
			const chunks: Uint8Array[] = [];
			return {
				write: async (chunk: any) => {
					if (typeof chunk === 'string') {
						chunks.push(new TextEncoder().encode(chunk));
					} else if (chunk instanceof ArrayBuffer) {
						chunks.push(new Uint8Array(chunk));
					} else if (ArrayBuffer.isView(chunk)) {
						chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
					} else if (chunk && typeof chunk === 'object' && 'type' in chunk && chunk.type === 'write' && chunk.data) {
						let data = chunk.data;
						if (typeof data === 'string') {
							chunks.push(new TextEncoder().encode(data));
						} else if (data instanceof ArrayBuffer) {
							chunks.push(new Uint8Array(data));
						} else if (ArrayBuffer.isView(data)) {
							chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
						} else {
							chunks.push(new Uint8Array(data));
						}
					} else {
						chunks.push(new Uint8Array(chunk));
					}
				},
				close: async () => {
					const size = chunks.reduce((acc, c) => acc + c.byteLength, 0);
					const buf = new Uint8Array(size);
					let offset = 0;
					for (const c of chunks) {
						buf.set(c, offset);
						offset += c.byteLength;
					}
					self.data = buf;
					self.mtime = Date.now();
				}
			};
		}
	}

	class MockDirectoryHandle {
		kind = 'directory' as const;
		entriesMap = new Map<string, MockDirectoryHandle | MockFileHandle>();
		constructor(public name: string) {}
		async isSameEntry(other: any) { return this === other; }
		async getDirectoryHandle(name: string, options?: { create?: boolean }) {
			let entry = this.entriesMap.get(name);
			if (!entry) {
				if (options?.create) {
					entry = new MockDirectoryHandle(name);
					this.entriesMap.set(name, entry);
				} else {
					const err = new Error('Not found');
					err.name = 'NotFoundError';
					throw err;
				}
			}
			if (entry.kind !== 'directory') {
				const err = new Error('Type mismatch');
				err.name = 'TypeMismatchError';
				throw err;
			}
			return entry as MockDirectoryHandle;
		}
		async getFileHandle(name: string, options?: { create?: boolean }) {
			let entry = this.entriesMap.get(name);
			if (!entry) {
				if (options?.create) {
					entry = new MockFileHandle(name);
					this.entriesMap.set(name, entry);
				} else {
					const err = new Error('Not found');
					err.name = 'NotFoundError';
					throw err;
				}
			}
			if (entry.kind !== 'file') {
				const err = new Error('Type mismatch');
				err.name = 'TypeMismatchError';
				throw err;
			}
			return entry as MockFileHandle;
		}
		async *keys() { for (const k of this.entriesMap.keys()) yield k; }
		async *values() { for (const v of this.entriesMap.values()) yield v; }
		async *entries() { for (const entry of this.entriesMap.entries()) yield entry; }
		async removeEntry(name: string, options?: { recursive?: boolean }) {
			const entry = this.entriesMap.get(name);
			if (entry && 'deleted' in entry) {
				(entry as any).deleted = true;
			}
			this.entriesMap.delete(name);
		}
		async resolve(possibleDescendant: any): Promise<string[] | null> {
			if (possibleDescendant === this) return [];
			for (const [name, entry] of this.entriesMap.entries()) {
				if (entry === possibleDescendant) return [name];
				if (entry.kind === 'directory') {
					const res = await (entry as MockDirectoryHandle).resolve(possibleDescendant);
					if (res !== null) return [name, ...res];
				}
			}
			return null;
		}
		async queryPermission() { return 'granted' as const; }
	}

	(window as any).MockFileHandle = MockFileHandle;
	(window as any).MockDirectoryHandle = MockDirectoryHandle;
}
