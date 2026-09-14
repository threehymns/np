import { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { DEFAULT_CONFIG_CONTENT } from './defaultConfig.js';
import { ConfigWatcher } from './ConfigWatcher.js';
import { SessionPersistenceEngine } from './SessionPersistenceEngine.js';

app.setName('np');
// Enable Chromium's native overlay scrollbars feature
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let configWatcher: ConfigWatcher | null = null;

// Helpers to get AppData persistence path
const getAppDataPath = () => {
	const userPath = app.getPath('userData');
	return path.join(userPath, 'state', 'workspace-session.json');
};

const sessionPersistence = new SessionPersistenceEngine({
	getFilePath: getAppDataPath,
	debounceMs: 500
});

function createWindow() {
	const preloadPath = fsSync.existsSync(path.join(__dirname, 'preload.cjs'))
		? path.join(__dirname, 'preload.cjs')
		: path.join(__dirname, 'preload.js');

	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		show: true, // Show immediately
		backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff',
		autoHideMenuBar: true,
		webPreferences: {
			preload: preloadPath,
			contextIsolation: true,
			nodeIntegration: false
		}
	});

	// Still send the event when ready for heavy tasks, 
	// but the window is already visible to the user.
	mainWindow.once('ready-to-show', () => {
		if (mainWindow) {
			mainWindow.webContents.send('window-shown');
		}
	});

	const devUrl = process.env.ELECTRON_DEV_URL;
	if (devUrl) {
		mainWindow.loadURL(devUrl);
	} else {
		mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
	}

	mainWindow.on('closed', () => {
		mainWindow = null;
	});
}

app.whenReady().then(() => {
	Menu.setApplicationMenu(null);
	registerIpcHandlers();

	const configPath = path.join(app.getPath('userData'), 'config.json');
	configWatcher = new ConfigWatcher({
		configPath,
		onConfigChanged: (content) => {
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send('config:changed', content);
			}
		}
	});
	configWatcher.start();

	createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

/**
 * Asks the renderer to flush its session state via awaited IPC saves and
 * waits for the preload's `session:flush-complete` reply (or a timeout).
 * Ensures Workspace.flushSaveOpenFiles()'s IPC work lands in the engine's
 * in-memory cache before flushSync() writes it to disk. Resolves
 * immediately when there is no live window to ask.
 */
function requestRendererFlush(timeoutMs = 2000): Promise<void> {
	return new Promise((resolve) => {
		if (!mainWindow || mainWindow.isDestroyed()) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			ipcMain.removeListener('session:flush-complete', onComplete);
			resolve();
		}, timeoutMs);
		const onComplete = () => {
			clearTimeout(timer);
			resolve();
		};
		ipcMain.once('session:flush-complete', onComplete);
		try {
			mainWindow.webContents.send('session:flush-request');
		} catch {
			clearTimeout(timer);
			ipcMain.removeListener('session:flush-complete', onComplete);
			resolve();
		}
	});
}

let isQuitting = false;
app.on('before-quit', (e) => {
	if (isQuitting) return;
	e.preventDefault();
	isQuitting = true;
	(async () => {
		try {
			await requestRendererFlush(2000);
			try {
				await sessionPersistence.flush();
			} catch (err) {
				console.error('Failed to flush persistence during quit:', err);
			}
		} finally {
			sessionPersistence.flushSync();
			if (configWatcher) {
				configWatcher.close();
				configWatcher = null;
			}
			app.quit();
		}
	})();
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

function registerIpcHandlers() {
	// Dialogs
	ipcMain.handle('dialog:openFile', async () => {
		if (!mainWindow) return null;
		const result = await dialog.showOpenDialog(mainWindow, {
			properties: ['openFile'],
			filters: [{ name: 'Markdown Files', extensions: ['md', 'txt'] }]
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		const filePath = result.filePaths[0];
		return {
			path: filePath,
			name: path.basename(filePath)
		};
	});

	ipcMain.handle('dialog:openDirectory', async () => {
		if (!mainWindow) return null;
		const result = await dialog.showOpenDialog(mainWindow, {
			properties: ['openDirectory', 'createDirectory']
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		const dirPath = result.filePaths[0];
		return {
			path: dirPath,
			name: path.basename(dirPath)
		};
	});

	ipcMain.handle('dialog:saveFile', async (_, options?: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
		if (!mainWindow) return null;
		const result = await dialog.showSaveDialog(mainWindow, {
			defaultPath: options?.defaultPath,
			filters: options?.filters
		});
		if (result.canceled || !result.filePath) return null;
		return result.filePath;
	});


	// FS operations
	ipcMain.handle('fs:readFile', async (_, filePath: string) => {
		return await fs.readFile(filePath);
	});

	ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content, 'utf-8');
	});

	ipcMain.handle('fs:createDirectory', async (_, dirPath: string) => {
		await fs.mkdir(dirPath, { recursive: true });
	});

	ipcMain.handle('fs:readDirectory', async (_, dirPath: string) => {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		return entries
			.filter(entry => entry.isFile() || entry.isDirectory())
			.map(entry => ({
				name: entry.name,
				kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
				path: path.join(dirPath, entry.name)
			}));
	});

	ipcMain.handle('fs:deleteEntry', async (_, entryPath: string) => {
		await fs.rm(entryPath, { recursive: true, force: true });
	});

	ipcMain.handle('fs:renameEntry', async (_, oldPath: string, newName: string) => {
		const newPath = path.join(path.dirname(oldPath), newName);
		await fs.rename(oldPath, newPath);
		return newPath;
	});

	// Git commands runner
	ipcMain.handle('git:run', async (_, workingDir: string, args: string[]) => {
		return new Promise((resolve) => {
			console.log(`Running git inside ${workingDir}: git ${args.join(' ')}`);
			const gitProcess = spawn('git', args, { cwd: workingDir });

			let stdout = '';
			let stderr = '';

			gitProcess.stdout.on('data', (data) => {
				stdout += data.toString();
			});

			gitProcess.stderr.on('data', (data) => {
				stderr += data.toString();
			});

			gitProcess.on('close', (code) => {
				resolve({
					code: code ?? 0,
					stdout,
					stderr
				});
			});

			gitProcess.on('error', (err) => {
				resolve({
					code: -1,
					stdout: '',
					stderr: err.message
				});
			});
		});
	});

	// Persistence handlers
	ipcMain.handle('persistence:save', async (_, key: string, value: any) => {
		try {
			await sessionPersistence.save(key, value);
		} catch (e) {
			console.error(`Failed to save persistence key "${key}":`, e);
		}
	});

	ipcMain.handle('persistence:load', async (_, key: string) => {
		try {
			return await sessionPersistence.load(key);
		} catch (e) {
			console.error(`Failed to load persistence key "${key}":`, e);
			return null;
		}
	});

	ipcMain.handle('persistence:loadAll', async () => {
		try {
			return await sessionPersistence.loadAll();
		} catch (e) {
			console.error('Failed to load all persistence:', e);
			return {};
		}
	});

	ipcMain.handle('persistence:flush', async () => {
		try {
			await sessionPersistence.flush();
		} catch (e) {
			console.error('Failed to flush persistence:', e);
		}
	});

	ipcMain.handle('window:show', () => {
		if (mainWindow) {
			if (!mainWindow.isVisible()) {
				mainWindow.show();
			}
			mainWindow.webContents.send('window-shown');
		}
	});

	ipcMain.handle('keymap:read', async () => {
		const filePath = path.join(app.getPath('userData'), 'keymap.json');
		try {
			return await fs.readFile(filePath, 'utf-8');
		} catch {
			return null;
		}
	});

	ipcMain.handle('keymap:write', async (_, content: string) => {
		const filePath = path.join(app.getPath('userData'), 'keymap.json');
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content, 'utf-8');
	});

	ipcMain.handle('config:getPath', async () => {
		const filePath = path.join(app.getPath('userData'), 'config.json');
		try {
			try {
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				await fs.writeFile(filePath, DEFAULT_CONFIG_CONTENT, { encoding: 'utf-8', flag: 'wx' });
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
					const stat = await fs.stat(filePath);
					if (!stat.isFile()) {
						throw e;
					}
				} else {
					throw e;
				}
			}
			return filePath;
		} catch (e) {
			console.error('Failed to ensure config.json exists in config:getPath:', e);
			throw e;
		}
	});

	ipcMain.on('config:readSync', (event) => {
		const filePath = path.join(app.getPath('userData'), 'config.json');
		try {
			try {
				fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
				fsSync.writeFileSync(filePath, DEFAULT_CONFIG_CONTENT, { encoding: 'utf-8', flag: 'wx' });
				event.returnValue = DEFAULT_CONFIG_CONTENT;
				return;
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
					const stat = fsSync.statSync(filePath);
					if (!stat.isFile()) {
						throw e;
					}
				} else {
					throw e;
				}
			}
			event.returnValue = fsSync.readFileSync(filePath, 'utf-8');
		} catch (e) {
			console.error('Failed to read config.json synchronously:', e);
			event.returnValue = null;
		}
	});

	ipcMain.handle('config:write', async (_, content: string) => {
		const filePath = path.join(app.getPath('userData'), 'config.json');
		try {
			if (configWatcher) {
				configWatcher.setLastWrittenContent(content);
			}
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content, 'utf-8');
		} catch (e) {
			// Clear the pending self-write marker so a later external change or
			// retry is not wrongly suppressed, then surface the failure to the renderer.
			configWatcher?.clearLastWrittenIfMatches(content);
			console.error('Failed to write config.json:', e);
			throw e;
		}
	});

	ipcMain.handle('window:toggleDevTools', () => {
		if (mainWindow) {
			mainWindow.webContents.toggleDevTools();
		}
	});
}

