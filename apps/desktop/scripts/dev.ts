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

function getElectronPath(): string {
	try {
		return require('electron');
	} catch {
		console.log('Failed to require("electron"), falling back to "electron" binary');
		return 'electron';
	}
}

function startElectron(electronPath: string, onExit: () => void) {
	if (electronProcess) {
		isRestarting = true;
		electronProcess.kill('SIGTERM');
		electronProcess = null;
	}

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
		onExit();
	});
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

	const cleanupAndExit = () => {
		server.close();
		if (electronProcess) {
			electronProcess.kill('SIGTERM');
		}
		process.exit(0);
	};

	startElectron(electronPath, cleanupAndExit);

	// Watch main process files (excluding renderer)
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	fs.watch(srcDir, { recursive: true }, (_eventType, filename) => {
		if (!filename) return;
		if (filename.startsWith('renderer') || filename.includes('node_modules')) return;
		if (!filename.endsWith('.ts') && !filename.endsWith('.cts') && !filename.endsWith('.js')) return;

		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(async () => {
			console.log(`Main process file changed: ${filename}. Rebuilding...`);
			const ok = await buildMainProcess();
			if (ok) {
				console.log('Restarting Electron...');
				startElectron(electronPath, cleanupAndExit);
			}
		}, 150);
	});

	process.on('SIGINT', cleanupAndExit);
	process.on('SIGTERM', cleanupAndExit);
}

start().catch((err) => {
	console.error('Failed to start dev environment:', err);
	process.exit(1);
});
