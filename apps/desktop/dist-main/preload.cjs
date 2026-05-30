"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    openFile: () => electron_1.ipcRenderer.invoke('dialog:openFile'),
    openDirectory: () => electron_1.ipcRenderer.invoke('dialog:openDirectory'),
    readFile: (filePath) => electron_1.ipcRenderer.invoke('fs:readFile', filePath),
    writeFile: (filePath, content) => electron_1.ipcRenderer.invoke('fs:writeFile', filePath, content),
    readDirectory: (dirPath) => electron_1.ipcRenderer.invoke('fs:readDirectory', dirPath),
    createDirectory: (dirPath) => electron_1.ipcRenderer.invoke('fs:createDirectory', dirPath),
    deleteEntry: (entryPath) => electron_1.ipcRenderer.invoke('fs:deleteEntry', entryPath),
    renameEntry: (oldPath, newName) => electron_1.ipcRenderer.invoke('fs:renameEntry', oldPath, newName),
    gitRun: (workingDir, args) => electron_1.ipcRenderer.invoke('git:run', workingDir, args),
    persistenceSave: (key, value) => electron_1.ipcRenderer.invoke('persistence:save', key, value),
    persistenceLoad: (key) => electron_1.ipcRenderer.invoke('persistence:load', key),
    persistenceLoadAll: () => electron_1.ipcRenderer.invoke('persistence:loadAll'),
    showWindow: () => electron_1.ipcRenderer.invoke('window:show'),
    onWindowShown: (callback) => electron_1.ipcRenderer.once('window-shown', () => callback()),
    readFileUserKeymap: () => electron_1.ipcRenderer.invoke('keymap:read'),
    writeFileUserKeymap: (content) => electron_1.ipcRenderer.invoke('keymap:write', content),
    toggleDevTools: () => electron_1.ipcRenderer.invoke('window:toggleDevTools')
});
