import { createServer } from 'vite';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function start() {
	const server = await createServer({
		configFile: path.resolve(__dirname, '../vite.config.ts'),
		server: { port: 5183 }
	});
	await server.listen();
	console.log('Vite dev server listening on http://localhost:5183');

	// Compile main process
	console.log('Compiling main process...');
	const tscProcess = spawn('bun', ['tsc', '-p', 'tsconfig.main.json'], { 
		cwd: path.resolve(__dirname, '..'),
		stdio: 'inherit' 
	});
	
	await new Promise((resolve) => {
		tscProcess.on('exit', resolve);
	});

	const electronModule = await import('electron');
	const electronPath = typeof electronModule.default === 'string' ? electronModule.default : 'electron';

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
