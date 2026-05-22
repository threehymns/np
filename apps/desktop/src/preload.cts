import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
	openFile: () => ipcRenderer.invoke('dialog:openFile'),
	openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
	readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
	writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
	readDirectory: (dirPath: string) => ipcRenderer.invoke('fs:readDirectory', dirPath),
	createDirectory: (dirPath: string) => ipcRenderer.invoke('fs:createDirectory', dirPath),
	deleteEntry: (entryPath: string) => ipcRenderer.invoke('fs:deleteEntry', entryPath),
	renameEntry: (oldPath: string, newName: string) => ipcRenderer.invoke('fs:renameEntry', oldPath, newName),
	gitRun: (workingDir: string, args: string[]) => ipcRenderer.invoke('git:run', workingDir, args),
	persistenceSave: (key: string, value: any) => ipcRenderer.invoke('persistence:save', key, value),
	persistenceLoad: (key: string) => ipcRenderer.invoke('persistence:load', key)
});
