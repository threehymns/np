/**
 * A token naming a spawn plan the main process minted and holds. It is passed
 * back verbatim rather than rebuilt by the renderer, so the only thing the
 * renderer chooses is which descriptor command to ask about.
 */
/** The descriptor's declaration of which packaged package its server ships in. */
export interface BundledLspCommand {
	package: string;
	binary: string;
}

export type ResolvedLspCommandToken = string;

export interface ElectronAPI {
	openFile(): Promise<{ path: string; name: string } | null>;
	openDirectory(): Promise<{ path: string; name: string } | null>;
	saveFileDialog(options?: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
	readFile(filePath: string): Promise<Uint8Array | IpcNotFoundError>;

	writeFile(filePath: string, content: string): Promise<void>;
	isSymlink(filePath: string): Promise<boolean>;
	readDirectory(dirPath: string): Promise<Array<{ name: string; kind: 'file' | 'directory'; path: string }> | IpcNotFoundError>;
	createDirectory(dirPath: string): Promise<void>;
	deleteEntry(entryPath: string): Promise<void>;
	renameEntry(oldPath: string, newName: string): Promise<string>;
	gitRun(workingDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
	fileExists(path: string): Promise<boolean>;
	/**
	 * Resolves a declared server command against the packaged dependency and
	 * then against PATH, in the main process (spec #263). Returns a token naming
	 * the stored spawn plan rather than the plan itself, so `spawnLspServer`
	 * cannot be given a command of its own. `bundled` is the descriptor's own
	 * declaration, which is why the resolver keeps no table of server names.
	 */
	resolveLspCommand(command: string, bundled?: BundledLspCommand): Promise<ResolvedLspCommandToken>;
	spawnLspServer(
		token: ResolvedLspCommandToken,
		args: string[],
		cwd: string
	): Promise<{ processId: string; pid: number | null; parentPid: number | null }>;
	writeLspServer(processId: string, chunk: Uint8Array): void;
	endLspServer(processId: string): void;
	killLspServer(processId: string): Promise<void>;
	lspMemory(processId: string): Promise<number | null>;
	onLspServerData(handlers: {
		onStdout: (processId: string, chunk: Uint8Array) => void;
		onStderr: (processId: string, chunk: Uint8Array) => void;
		onExit: (exit: { processId: string; code: number; signal: string | null; error?: string }) => void;
	}): () => void;
	persistenceSave(key: string, value: any): Promise<void>;
	persistenceLoad(key: string): Promise<any>;
	persistenceLoadAll(): Promise<Record<string, any>>;
	persistenceFlush(): Promise<void>;
	onSessionFlushRequest(handler: () => Promise<void> | void): () => void;
	showWindow(): Promise<void>;
	readFileUserKeymap(): Promise<string | null>;
	writeFileUserKeymap(content: string): Promise<void>;
	readConfigFileSync(): string | null;
	writeConfigFile(content: string): Promise<void>;
	getConfigPath(): Promise<string>;
	onConfigChanged(callback: (content: string) => void): () => void;
	toggleDevTools(): Promise<void>;
}

declare global {
	interface Window {
		electronAPI: ElectronAPI;
	}
}

export interface IpcNotFoundError {
	name: 'NotFoundError';
	code: 'ENOENT';
	message: string;
}
