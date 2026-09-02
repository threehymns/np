export interface ElectronAPI {
	openFile(): Promise<{ path: string; name: string } | null>;
	openDirectory(): Promise<{ path: string; name: string } | null>;
	saveFileDialog(options?: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>;
	readFile(filePath: string): Promise<Uint8Array>;

	writeFile(filePath: string, content: string): Promise<void>;
	readDirectory(dirPath: string): Promise<Array<{ name: string; kind: 'file' | 'directory'; path: string }>>;
	createDirectory(dirPath: string): Promise<void>;
	deleteEntry(entryPath: string): Promise<void>;
	renameEntry(oldPath: string, newName: string): Promise<string>;
	gitRun(workingDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
	persistenceSave(key: string, value: any): Promise<void>;
	persistenceLoad(key: string): Promise<any>;
	persistenceLoadAll(): Promise<Record<string, any>>;
	showWindow(): Promise<void>;
	onWindowShown(callback: () => void): void;
	readFileUserKeymap(): Promise<string | null>;
	writeFileUserKeymap(content: string): Promise<void>;
	readConfigFileSync(): string | null;
	writeConfigFile(content: string): Promise<void>;
	getConfigPath(): Promise<string>;
	toggleDevTools(): Promise<void>;
}

declare global {
	interface Window {
		electronAPI: ElectronAPI;
	}
}
