export interface FileOrigin {
	scheme: string;
	path: string;
	name: string;
}

export function toURI(origin: FileOrigin): string {
	if (origin.scheme === 'file') {
		return `file://${origin.path.startsWith('/') ? '' : '/'}${origin.path}`;
	}
	return `${origin.scheme}://${origin.path}`;
}

export function parseURI(uriString: string): FileOrigin {
	const idx = uriString.indexOf('://');
	if (idx === -1) {
		throw new Error(`Invalid URI: ${uriString}`);
	}
	const scheme = uriString.slice(0, idx);
	const rest = uriString.slice(idx + 3);
	let path = rest;
	if (scheme === 'file' && !path.startsWith('/')) {
		path = '/' + path;
	}
	const name = path.split('/').pop() || '';
	return { scheme, path, name };
}

export interface StorageEntry {
	name: string;
	kind: 'file' | 'directory';
	origin: FileOrigin;
}

export interface StorageProvider {
	scheme: string;
	pickFile(): Promise<FileOrigin | null>;
	pickDirectory(): Promise<FileOrigin | null>;
	saveFile(content: string, existingOrigin?: FileOrigin): Promise<FileOrigin | null>;
	readFile(origin: FileOrigin): Promise<string>;
	readDirectory(origin: FileOrigin): Promise<StorageEntry[]>;
	verifyPermission(origin: FileOrigin, readWrite?: boolean): Promise<boolean>;
	queryPermission(origin: FileOrigin, readWrite?: boolean): Promise<'granted' | 'prompt' | 'denied'>;
	createFile(parent: FileOrigin, name: string): Promise<FileOrigin>;
	createDirectory(parent: FileOrigin, name: string): Promise<FileOrigin>;
	deleteEntry(origin: FileOrigin): Promise<void>;
	renameEntry(origin: FileOrigin, newName: string): Promise<FileOrigin>;
}

export interface Storage {
	pickFile(): Promise<FileOrigin | null>;
	pickDirectory(): Promise<FileOrigin | null>;
	saveFile(content: string, existingOrigin?: FileOrigin): Promise<FileOrigin | null>;
	readFile(origin: FileOrigin): Promise<string>;
	readDirectory(origin: FileOrigin): Promise<StorageEntry[]>;
	verifyPermission(origin: FileOrigin, readWrite?: boolean): Promise<boolean>;
	queryPermission(origin: FileOrigin, readWrite?: boolean): Promise<'granted' | 'prompt' | 'denied'>;
	createFile(parent: FileOrigin, name: string): Promise<FileOrigin>;
	createDirectory(parent: FileOrigin, name: string): Promise<FileOrigin>;
	deleteEntry(origin: FileOrigin): Promise<void>;
	renameEntry(origin: FileOrigin, newName: string): Promise<FileOrigin>;
}

export class MultiSchemeStorage implements Storage {
	private providers = new Map<string, StorageProvider>();
	private defaultScheme: string | null = null;

	constructor(defaultScheme?: string) {
		if (defaultScheme) {
			this.defaultScheme = defaultScheme;
		}
	}

	setDefaultScheme(scheme: string) {
		this.defaultScheme = scheme;
	}

	registerProvider(scheme: string, provider: StorageProvider) {
		this.providers.set(scheme, provider);
		if (!this.defaultScheme) {
			this.defaultScheme = scheme;
		}
	}

	private getProvider(scheme: string): StorageProvider {
		const provider = this.providers.get(scheme);
		if (!provider) {
			throw new Error(`No storage provider registered for scheme: ${scheme}`);
		}
		return provider;
	}

	async pickFile(): Promise<FileOrigin | null> {
		if (!this.defaultScheme) throw new Error("No default scheme configured");
		return await this.getProvider(this.defaultScheme).pickFile();
	}

	async pickDirectory(): Promise<FileOrigin | null> {
		if (!this.defaultScheme) throw new Error("No default scheme configured");
		return await this.getProvider(this.defaultScheme).pickDirectory();
	}

	async saveFile(content: string, existingOrigin?: FileOrigin): Promise<FileOrigin | null> {
		const scheme = existingOrigin?.scheme ?? this.defaultScheme;
		if (!scheme) throw new Error("No scheme available for saveFile");
		return await this.getProvider(scheme).saveFile(content, existingOrigin);
	}

	async readFile(origin: FileOrigin): Promise<string> {
		return await this.getProvider(origin.scheme).readFile(origin);
	}

	async readDirectory(origin: FileOrigin): Promise<StorageEntry[]> {
		return await this.getProvider(origin.scheme).readDirectory(origin);
	}

	async verifyPermission(origin: FileOrigin, readWrite = false): Promise<boolean> {
		return await this.getProvider(origin.scheme).verifyPermission(origin, readWrite);
	}

	async queryPermission(origin: FileOrigin, readWrite = false): Promise<'granted' | 'prompt' | 'denied'> {
		return await this.getProvider(origin.scheme).queryPermission(origin, readWrite);
	}

	async createFile(parent: FileOrigin, name: string): Promise<FileOrigin> {
		return await this.getProvider(parent.scheme).createFile(parent, name);
	}

	async createDirectory(parent: FileOrigin, name: string): Promise<FileOrigin> {
		return await this.getProvider(parent.scheme).createDirectory(parent, name);
	}

	async deleteEntry(origin: FileOrigin): Promise<void> {
		return await this.getProvider(origin.scheme).deleteEntry(origin);
	}

	async renameEntry(origin: FileOrigin, newName: string): Promise<FileOrigin> {
		return await this.getProvider(origin.scheme).renameEntry(origin, newName);
	}
}

if (typeof window !== 'undefined') {
	(window as any).toURI = toURI;
	(window as any).parseURI = parseURI;
}
