import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
	openFile: () => ipcRenderer.invoke('dialog:openFile'),
	openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
	saveFileDialog: (options?: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) =>
		ipcRenderer.invoke('dialog:saveFile', options),
	readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),

	writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
	isSymlink: (filePath: string) => ipcRenderer.invoke('fs:isSymlink', filePath),
	readDirectory: (dirPath: string) => ipcRenderer.invoke('fs:readDirectory', dirPath),
	createDirectory: (dirPath: string) => ipcRenderer.invoke('fs:createDirectory', dirPath),
	deleteEntry: (entryPath: string) => ipcRenderer.invoke('fs:deleteEntry', entryPath),
	renameEntry: (oldPath: string, newName: string) => ipcRenderer.invoke('fs:renameEntry', oldPath, newName),
	gitRun: (workingDir: string, args: string[]) => ipcRenderer.invoke('git:run', workingDir, args),
	fileExists: (path: string) => ipcRenderer.invoke('fs:exists', path),
	spawnLspServer: (command: string, args: string[], cwd: string) =>
		ipcRenderer.invoke('lsp:spawn', command, args, cwd),
	writeLspServer: (processId: string, chunk: Uint8Array) =>
		ipcRenderer.send('lsp:write', processId, chunk),
	endLspServer: (processId: string) => ipcRenderer.send('lsp:end', processId),
	killLspServer: (processId: string) => ipcRenderer.invoke('lsp:kill', processId),
	onLspServerData: (handlers: {
		onStdout: (processId: string, chunk: Uint8Array) => void;
		onStderr: (processId: string, chunk: Uint8Array) => void;
		onExit: (exit: { processId: string; code: number; signal: string | null; error?: string }) => void;
	}) => {
		// One listener per channel for every server: the per-process routing lives
		// in the adapter, so a second server does not need a second subscription.
		const stdout = (_event: unknown, payload: { processId: string; chunk: Uint8Array }) =>
			handlers.onStdout(payload.processId, payload.chunk);
		const stderr = (_event: unknown, payload: { processId: string; chunk: Uint8Array }) =>
			handlers.onStderr(payload.processId, payload.chunk);
		const exit = (_event: unknown, payload: { processId: string; code: number; signal: string | null; error?: string }) =>
			handlers.onExit(payload);
		ipcRenderer.on('lsp:stdout', stdout);
		ipcRenderer.on('lsp:stderr', stderr);
		ipcRenderer.on('lsp:exit', exit);
		return () => {
			ipcRenderer.removeListener('lsp:stdout', stdout);
			ipcRenderer.removeListener('lsp:stderr', stderr);
			ipcRenderer.removeListener('lsp:exit', exit);
		};
	},
	persistenceSave: (key: string, value: any) => ipcRenderer.invoke('persistence:save', key, value),
	persistenceLoad: (key: string) => ipcRenderer.invoke('persistence:load', key),
	persistenceLoadAll: () => ipcRenderer.invoke('persistence:loadAll'),
	persistenceFlush: () => ipcRenderer.invoke('persistence:flush'),
	onSessionFlushRequest: (handler: () => Promise<void> | void) => {
		const listener = async () => {
			try {
				await handler();
			} finally {
				ipcRenderer.send('session:flush-complete');
			}
		};
		ipcRenderer.on('session:flush-request', listener);
		return () => {
			ipcRenderer.removeListener('session:flush-request', listener);
		};
	},
	showWindow: () => ipcRenderer.invoke('window:show'),
	readFileUserKeymap: () => ipcRenderer.invoke('keymap:read'),
	writeFileUserKeymap: (content: string) => ipcRenderer.invoke('keymap:write', content),
	readConfigFileSync: () => ipcRenderer.sendSync('config:readSync'),
	writeConfigFile: (content: string) => ipcRenderer.invoke('config:write', content),
	getConfigPath: () => ipcRenderer.invoke('config:getPath'),
	onConfigChanged: (callback: (content: string) => void) => {
		const listener = (_event: any, content: string) => callback(content);
		ipcRenderer.on('config:changed', listener);
		return () => {
			ipcRenderer.removeListener('config:changed', listener);
		};
	},
	toggleDevTools: () => ipcRenderer.invoke('window:toggleDevTools')
});

