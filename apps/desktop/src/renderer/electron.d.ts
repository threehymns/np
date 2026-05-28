export interface ElectronAPI {
	openFile(): Promise<{ path: string; name: string } | null>;
	openDirectory(): Promise<{ path: string; name: string } | null>;
	readFile(filePath: string): Promise<Uint8Array>;
	writeFile(filePath: string, content: string): Promise<void>;
	readDirectory(dirPath: string): Promise<Array<{ name: string; kind: 'file' | 'directory'; path: string }>>;
	createDirectory(dirPath: string): Promise<void>;
	deleteEntry(entryPath: string): Promise<void>;
	renameEntry(oldPath: string, newName: string): Promise<string>;
	gitRun(workingDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
	persistenceSave(key: string, value: any): Promise<void>;
	persistenceLoad(key: string): Promise<any>;
}

declare global {
	interface Window {
		electronAPI: ElectronAPI;
	}
}
