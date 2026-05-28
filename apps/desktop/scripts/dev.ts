import { createServer } from 'vite';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function start() {
	console.log('Starting dev environment...');

	// Start Vite dev server
	const serverPromise = createServer({
		configFile: path.resolve(__dirname, '../vite.config.ts'),
		server: { port: 5183 }
	}).then(async (server) => {
		await server.listen();
		console.log('Vite dev server listening on http://localhost:5183');
		return server;
	});

	// Compile main process with tsc in parallel
	console.log('Compiling main process...');
	const compilePromise = new Promise<void>((resolve, reject) => {
		const tscProcess = spawn('bun', ['tsc', '-p', 'tsconfig.main.json'], { 
			cwd: path.resolve(__dirname, '..'),
			stdio: 'inherit' 
		});
		tscProcess.on('error', (err) => {
			reject(new Error(`Failed to spawn tsc process: ${err.message}`));
		});
		tscProcess.on('exit', (code) => {
			if (code === 0) {
				console.log('Main process compiled successfully');
				resolve();
			} else if (code === null) {
				reject(new Error('Main process compilation was terminated'));
			} else {
				reject(new Error(`Main process compilation failed with code ${code}`));
			}
		});
	});

	// Wait for both to be ready
	const [server] = await Promise.all([serverPromise, compilePromise]);

	let electronPath: string;
	try {
		electronPath = require('electron');
	} catch (e) {
		console.log('Failed to require("electron"), falling back to "electron" binary');
		electronPath = 'electron';
	}

	console.log(`Spawning Electron from: ${electronPath}`);
	const electronProcess = spawn(
		electronPath,
		[path.resolve(__dirname, '..'), '--ozone-platform-hint=auto', '--enable-features=WaylandWindowDecorations'],
		{
			stdio: 'inherit',
			env: {
				...process.env,
				ELECTRON_DEV_URL: 'http://localhost:5183',
				NODE_ENV: 'development'
			}
		}
	);

	electronProcess.on('exit', (code) => {
		console.log(`Electron process exited with code ${code}`);
		server.close();
		process.exit(code ?? 0);
	});
}

start().catch(err => {
	console.error('Failed to start dev environment:', err);
	process.exit(1);
});
