import { createServer } from 'vite';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, '..');
const srcDir = path.resolve(desktopRoot, 'src');
const distMainDir = path.resolve(desktopRoot, 'dist-main');

let electronProcess: ChildProcess | null = null;
let isRestarting = false;
let isBuilding = false;
let rebuildQueued: { filename: string } | null = null;

async function buildMainProcess(): Promise<boolean> {
	const startTime = performance.now();
	const [mainResult, preloadResult] = await Promise.all([
		Bun.build({
			entrypoints: [path.resolve(srcDir, 'main.ts')],
			outdir: distMainDir,
			target: 'node',
			packages: 'external',
			external: ['electron']
		}),
		Bun.build({
			entrypoints: [path.resolve(srcDir, 'preload.cts')],
			outfile: path.resolve(distMainDir, 'preload.cjs'),
			target: 'node',
			format: 'cjs',
			packages: 'external',
			external: ['electron']
		})
	]);

	if (!mainResult.success || !preloadResult.success) {
		console.error('Failed to build main process:');
		for (const log of [...mainResult.logs, ...preloadResult.logs]) {
			console.error(log);
		}
		return false;
	}

	const elapsed = (performance.now() - startTime).toFixed(0);
	console.log(`Main process built in ${elapsed}ms`);
	return true;
}

function toPosix(p: string): string {
	return p.replace(/\\/g, '/');
}

function isMainProcessFile(relPosix: string): boolean {
	if (relPosix === 'renderer' || relPosix.startsWith('renderer/')) return false;
	if (relPosix.includes('node_modules')) return false;
	return relPosix.endsWith('.ts') || relPosix.endsWith('.cts') || relPosix.endsWith('.js');
}

/**
 * Watch main-process files under src/ (renderer is excluded: Vite HMR owns it).
 * Node's recursive fs.watch only works on macOS/Windows, so on Linux each
 * subdirectory is watched individually and re-scanned on rename events —
 * new nesting is picked up instead of silently going unwatched. No extra dep.
 */
function watchMainProcessFiles(onChange: (relPosix: string) => void): () => void {
	const watchers: import('fs').FSWatcher[] = [];

	if (process.platform === 'win32' || process.platform === 'darwin') {
		console.log('Watching main process files (native recursive watch)...');
		watchers.push(
			fs.watch(srcDir, { recursive: true }, (_eventType, rawFilename) => {
				if (!rawFilename) return;
				const rel = toPosix(rawFilename.toString());
				if (!isMainProcessFile(rel)) return;
				onChange(rel);
			})
		);
		return () => {
			for (const w of watchers) w.close();
		};
	}

	console.log('Watching main process files (per-directory fallback: recursive fs.watch is unsupported on Linux)...');
	const watched = new Set<string>();
	const scan = () => {
		const stack = [srcDir];
		while (stack.length > 0) {
			const dir = stack.pop()!;
			if (watched.has(dir) && !fs.existsSync(dir)) {
				watched.delete(dir);
			}
			if (!watched.has(dir)) {
				watched.add(dir);
				try {
					const watcher = fs.watch(dir, (eventType, rawFilename) => {
						if (eventType === 'rename') queueMicrotask(scan);
						if (!rawFilename) return;
						const rel = toPosix(path.relative(srcDir, path.join(dir, rawFilename.toString())));
						if (!isMainProcessFile(rel)) return;
						onChange(rel);
					});
					watcher.on('error', (err) => console.warn(`Watcher error for ${dir}:`, err));
					watchers.push(watcher);
				} catch (err) {
					console.warn(`Failed to watch ${dir}:`, err);
					continue;
				}
			}
			let entries: import('fs').Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (entry.name === 'renderer' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
				stack.push(path.join(dir, entry.name));
			}
		}
	};
	scan();

	return () => {
		for (const w of watchers) w.close();
	};
}

function getElectronPath(): string {
	try {
		return require('electron');
	} catch {
		console.log('Failed to require("electron"), falling back to "electron" binary');
		return 'electron';
	}
}

function startElectron(electronPath: string, onExit: (code: number | null) => void) {
	console.log(`Spawning Electron from: ${electronPath}`);
	const proc = spawn(
		electronPath,
		[desktopRoot, '--ozone-platform-hint=auto', '--enable-features=WaylandWindowDecorations'],
		{
			stdio: 'inherit',
			env: {
				...process.env,
				ELECTRON_DEV_URL: 'http://localhost:5183',
				NODE_ENV: 'development'
			}
		}
	);

	electronProcess = proc;

	proc.on('exit', (code) => {
		if (isRestarting) {
			isRestarting = false;
			return;
		}
		console.log(`Electron process exited with code ${code}`);
		onExit(code);
	});
}

async function stopElectron(): Promise<void> {
	const proc = electronProcess;
	if (!proc) return;
	electronProcess = null;
	isRestarting = true;
	await new Promise<void>((resolve) => {
		const timeout = setTimeout(() => {
			try {
				proc.kill('SIGKILL');
			} catch {
				// Already exited
			}
			resolve();
		}, 3000);
		proc.once('exit', () => {
			clearTimeout(timeout);
			resolve();
		});
		try {
			proc.kill('SIGTERM');
		} catch {
			clearTimeout(timeout);
			resolve();
		}
	});
}

async function restartElectron(electronPath: string, onExit: (code: number | null) => void) {
	await stopElectron();
	startElectron(electronPath, onExit);
}

async function rebuildAndRestart(
	filename: string,
	electronPath: string,
	onExit: (code: number | null) => void
): Promise<void> {
	if (isBuilding) {
		rebuildQueued = { filename };
		return;
	}
	isBuilding = true;
	try {
		console.log(`Main process file changed: ${filename}. Rebuilding...`);
		const ok = await buildMainProcess();
		if (ok) {
			console.log('Restarting Electron...');
			await restartElectron(electronPath, onExit);
		}
	} finally {
		isBuilding = false;
		if (rebuildQueued) {
			const queued = rebuildQueued;
			rebuildQueued = null;
			await rebuildAndRestart(queued.filename, electronPath, onExit);
		}
	}
}

async function start() {
	console.log('Starting dev environment...');

	// Start Vite dev server and build main process concurrently
	const serverPromise = createServer({
		root: desktopRoot,
		configFile: path.resolve(__dirname, '../vite.config.ts'),
		server: { port: 5183 }
	}).then(async (server) => {
		await server.listen();
		console.log('Vite dev server listening on http://localhost:5183');
		return server;
	});

	const buildPromise = buildMainProcess();

	const [server, buildSuccess] = await Promise.all([serverPromise, buildPromise]);
	if (!buildSuccess) {
		server.close();
		process.exit(1);
	}

	const electronPath = getElectronPath();

	const cleanupAndExit = (code: number | null = 0) => {
		void server.close().catch(() => {});
		if (electronProcess) {
			try {
				electronProcess.kill('SIGTERM');
			} catch {
				// Already exited
			}
		}
		process.exit(code ?? 0);
	};

	startElectron(electronPath, cleanupAndExit);

	// Watch main process files (excluding renderer, which Vite HMR handles)
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	watchMainProcessFiles((filename) => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			void rebuildAndRestart(filename, electronPath, cleanupAndExit);
		}, 150);
	});

	process.on('SIGINT', () => cleanupAndExit(0));
	process.on('SIGTERM', () => cleanupAndExit(0));
}

start().catch((err) => {
	console.error('Failed to start dev environment:', err);
	process.exit(1);
});
