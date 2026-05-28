import { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

// Helpers to get AppData persistence path
const getAppDataPath = () => {
	const userPath = app.getPath('userData');
	return path.join(userPath, 'np-workspace-persistence.json');
};

async function readPersistenceFile(): Promise<Record<string, any>> {
	const filePath = getAppDataPath();
	try {
		const content = await fs.readFile(filePath, 'utf-8');
		return JSON.parse(content);
	} catch {
		return {};
	}
}

async function writePersistenceFile(data: Record<string, any>): Promise<void> {
	const filePath = getAppDataPath();
	try {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
	} catch (e) {
		console.error('Failed to write persistence file', e);
	}
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		show: true, // Show immediately
		backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff',
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
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
	createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
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
	let persistenceLock: Promise<void> = Promise.resolve();

	ipcMain.handle('persistence:save', async (_, key: string, value: any) => {
		persistenceLock = persistenceLock.then(async () => {
			try {
				const data = await readPersistenceFile();
				data[key] = value;
				await writePersistenceFile(data);
			} catch (e) {
				console.error(`Failed to save persistence key "${key}":`, e);
			}
		});
		return persistenceLock;
	});

	ipcMain.handle('persistence:load', async (_, key: string) => {
		return persistenceLock.then(async () => {
			try {
				const data = await readPersistenceFile();
				return data[key] ?? null;
			} catch (e) {
				console.error(`Failed to load persistence key "${key}":`, e);
				return null;
			}
		});
	});

	ipcMain.handle('persistence:loadAll', async () => {
		return persistenceLock.then(async () => {
			try {
				return await readPersistenceFile();
			} catch (e) {
				console.error('Failed to load all persistence:', e);
				return {};
			}
		});
	});

	ipcMain.handle('window:show', () => {
		if (mainWindow && !mainWindow.isVisible()) {
			mainWindow.show();
			mainWindow.webContents.send('window-shown');
		}
	});
}
