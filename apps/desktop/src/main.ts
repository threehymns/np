import { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } from 'electron';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'url';
import { DEFAULT_CONFIG_CONTENT } from './defaultConfig.js';
import { ConfigWatcher } from './ConfigWatcher.js';
import { SessionPersistenceEngine } from './SessionPersistenceEngine.js';
import {
	isValidBundledCommand,
	isValidLspCommandName,
	isValidSpawnArgs,
	isValidSpawnCwd,
	resolveLanguageServerCommand,
	type ResolvedServerCommand
} from './LspCommandResolver.js';

app.setName('np');
// Enable Chromium's native overlay scrollbars feature
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let configWatcher: ConfigWatcher | null = null;

/**
 * Language-server child processes (spec #263).
 *
 * Servers are long-lived streams, so they cannot ride the request/response
 * `git:run` handler: the renderer opens one process and then reads bytes until
 * it exits. Every chunk crosses as a `Uint8Array`, never as a string, precisely
 * so a multi-byte UTF-8 character that a pipe read split in half stays intact —
 * decoding either side of the boundary would insert U+FFFD into a source file
 * the server is about to parse (the same trap `git:run` documents below).
 *
 * The protocol's own `Content-Length` framing is the client's business, in
 * `@np/core`; main forwards bytes without interpreting them.
 */
const lspProcesses = new Map<string, ChildProcessWithoutNullStreams>();

/**
 * Spawn plans minted by `lsp:resolveCommand`, held behind unguessable tokens.
 *
 * The renderer never assembles a command: it asks for a descriptor command to
 * be resolved, gets a token back, and hands the token to `lsp:spawn`. A token
 * names one resolved plan, so a compromised renderer cannot turn `spawn` into
 * arbitrary execution by passing its own `command`.
 */
const lspPlans = new Map<string, ResolvedServerCommand>();

function sendToRenderer(channel: string, ...args: unknown[]): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send(channel, ...args);
}

function killLspProcess(processId: string): void {
	const child = lspProcesses.get(processId);
	if (!child) return;
	lspProcesses.delete(processId);
	if (child.exitCode === null && child.signalCode === null) child.kill();
}

/** Quitting with a server still running would leave an orphan nobody can stop. */
function killAllLspProcesses(): void {
	for (const processId of [...lspProcesses.keys()]) killLspProcess(processId);
}

/** Linux only. macOS and Windows report this figure differently, and an
 * unreadable or unparseable status is unknown memory, not a failed read. */
async function readProcessMemoryBytes(pid: number): Promise<number | null> {
	if (process.platform !== 'linux') return null;
	try {
		const status = await fs.readFile(`/proc/${pid}/status`, 'utf-8');
		const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
		if (!match) return null;
		return Number(match[1]) * 1024;
	} catch {
		return null;
	}
}

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
			killAllLspProcesses();
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
	// Intentional duplicate of @np/core's isNotFoundError (packages/core/src/utils.ts):
	// Electron main can't import the package, but must classify the same IPC
	// error and not-found-marker shapes. Keep the checks in lockstep.
	const isNotFoundError = (err: unknown): boolean => {
		if (!err || typeof err !== 'object') return false;
		const e = err as { code?: unknown; name?: unknown; message?: unknown };
		if (e.code === 'ENOENT' || e.name === 'NotFoundError' || e.name === 'ENOENT') return true;
		// A structured code that isn't ENOENT means a different failure (e.g.
		// EACCES); its message may still mention ENOENT via a chained cause,
		// so don't fall back to message matching (keep in lockstep with
		// @np/core's isNotFoundError).
		if (typeof e.code === 'string' && e.code !== 'ENOENT') return false;
		return (
			typeof e.message === 'string' &&
			/^(?:Error invoking remote method '[^']+': |Error: )*(?:(?:ENOENT|NotFoundError)(?::|,|$)|no such file or directory(?:,|$))/.test(e.message)
		);
	};

	// Missing files are an expected condition (e.g. a tab restored after the
	// file was deleted on disk). Resolve with a structured marker instead of
	// rejecting, so Electron doesn't log a spurious "Error occurred in handler"
	// for an error the renderer normalizes silently.
	const toNotFoundMarker = (err: unknown, filePath: string) => ({
		name: 'NotFoundError' as const,
		code: 'ENOENT' as const,
		message: err instanceof Error && err.message ? err.message : `No such file or directory: ${filePath}`
	});

	ipcMain.handle('fs:readFile', async (_, filePath: string) => {
		try {
			return await fs.readFile(filePath);
		} catch (err) {
			if (isNotFoundError(err)) return toNotFoundMarker(err, filePath);
			throw err;
		}
	});

	ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, content, 'utf-8');
	});

	// `lstat`, not `stat`: the answer must describe the link itself rather than
	// whatever it points at, which is the whole question the renderer is asking.
	ipcMain.handle('fs:isSymlink', async (_, filePath: string) => {
		try {
			return (await fs.lstat(filePath)).isSymbolicLink();
		} catch (err) {
			// A path that cannot be stat'd is certainly not a symlink, and the
			// renderer's own read will report the real reason if it matters.
			if (isNotFoundError(err)) return false;
			throw err;
		}
	});

	ipcMain.handle('fs:createDirectory', async (_, dirPath: string) => {
		await fs.mkdir(dirPath, { recursive: true });
	});

	ipcMain.handle('fs:readDirectory', async (_, dirPath: string) => {
		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true });
			return entries
				.filter(entry => entry.isFile() || entry.isDirectory())
				.map(entry => ({
					name: entry.name,
					kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
					path: path.join(dirPath, entry.name)
				}));
		} catch (err) {
			if (isNotFoundError(err)) return toNotFoundMarker(err, dirPath);
			throw err;
		}
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

			// Collect as Buffers and decode once at the end. Decoding each chunk as
			// it arrives corrupts any multi-byte UTF-8 sequence that straddles a
			// chunk boundary, turning a path like `café.txt` into U+FFFD. That is
			// reachable precisely because `git log -z` output is NUL-delimited and
			// routinely larger than one pipe read.
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];

			gitProcess.stdout.on('data', (data) => {
				stdout.push(data);
			});

			gitProcess.stderr.on('data', (data) => {
				stderr.push(data);
			});

			gitProcess.on('close', (code) => {
				resolve({
					code: code ?? 0,
					stdout: Buffer.concat(stdout).toString('utf8'),
					stderr: Buffer.concat(stderr).toString('utf8')
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

	// Root-marker probe for the LSP transport: whether a marker exists at an
	// absolute path. Resolved as a boolean here so the renderer never learns what
	// a marker is.
	ipcMain.handle('fs:exists', async (_, filePath: string) => {
		try {
			const stat = await fs.stat(filePath);
			return stat.isFile();
		} catch {
			return false;
		}
	});

	ipcMain.handle('lsp:resolveCommand', async (_event, command: string, bundled?: { package: string; binary: string }) => {
		// Validated before it is resolved: the renderer names a descriptor command
		// and its bundled declaration, never a path, so traversal or an absolute
		// binary never becomes a plan. The plan is held behind a token rather than
		// returned, so `lsp:spawn` cannot be given a command of its own.
		if (!isValidLspCommandName(command)) throw new Error(`Invalid language server command: ${String(command)}`);
		if (!isValidBundledCommand(bundled)) throw new Error('Invalid bundled server declaration.');
		const plan = resolveLanguageServerCommand(command, app.getAppPath(), bundled);
		const token = randomUUID();
		lspPlans.set(token, plan);
		return token;
	});

	ipcMain.handle('lsp:spawn', async (
		_event,
		token: string,
		args: string[],
		cwd: string
	) => {
		const plan = typeof token === 'string' ? lspPlans.get(token) : undefined;
		if (!plan) throw new Error('Unknown language server plan. Resolve the command first.');
		if (!isValidSpawnArgs(args)) throw new Error('Invalid language server arguments.');
		if (!isValidSpawnCwd(cwd)) throw new Error(`Invalid language server working directory: ${String(cwd)}`);
		try {
			// The plan was minted by `lsp:resolveCommand` rather than assembled by
			// the renderer, so a descriptor naming `vtsls` becomes a path in exactly
			// one place (see LspCommandResolver). The environment is merged here
			// rather than replaced: a server inherits the app's PATH and locale and
			// gains the one variable the bundled candidate needs.
			const child = spawn(plan.command, [...plan.args, ...args], {
				cwd,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env, ...plan.env }
			});
			const processId = randomUUID();
			lspProcesses.set(processId, child);
			child.on('error', (err) => {
				lspProcesses.delete(processId);
				sendToRenderer('lsp:exit', { processId, code: -1, signal: null, error: err.message });
			});
			child.on('close', (code, signal) => {
				lspProcesses.delete(processId);
				sendToRenderer('lsp:exit', { processId, code: code ?? -1, signal: signal ?? null });
			});
			// Bytes, not strings: see the note above `lspProcesses`.
			child.stdout.on('data', (chunk: Buffer) => sendToRenderer('lsp:stdout', { processId, chunk: new Uint8Array(chunk) }));
			child.stderr.on('data', (chunk: Buffer) => sendToRenderer('lsp:stderr', { processId, chunk: new Uint8Array(chunk) }));
			child.stdin.on('error', () => {
				// A server that closed its stdin makes further writes fail. The exit
				// handler reports the death; an unhandled EPIPE here would bury it.
			});
			return { processId, pid: child.pid ?? null, parentPid: process.pid ?? null };
		} catch (err) {
			throw new Error(
				`Failed to start language server "${plan.command}": ${(err as Error).message}`
			);
		}
	});

	ipcMain.on('lsp:write', (_event, processId: string, chunk: Uint8Array) => {
		const child = lspProcesses.get(processId);
		if (!child) return;
		child.stdin.write(Buffer.from(chunk));
	});

	ipcMain.on('lsp:end', (_event, processId: string) => {
		const child = lspProcesses.get(processId);
		if (!child) return;
		child.stdin.end();
	});

	ipcMain.handle('lsp:kill', async (_event, processId: string) => {
		killLspProcess(processId);
	});

	// Resolve the renderer's process id back to a pid: a compromised renderer
	// can ask about its own servers, never an arbitrary pid.
	ipcMain.handle('lsp:memory', async (_event, processId: string) => {
		const child = typeof processId === 'string' ? lspProcesses.get(processId) : undefined;
		if (!child?.pid) return null;
		return readProcessMemoryBytes(child.pid);
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
		if (mainWindow && !mainWindow.isVisible()) {
			mainWindow.show();
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

