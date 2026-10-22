/**
 * Diff-viewer test repository: a git repo with two modified files, wired
 * into the app as the project's repository.
 *
 * Self-contained on purpose: Playwright serializes this function's source
 * into the browser, so it must not reference imports or module-scope
 * bindings — only `window` globals.
 */
export async function installDiffTestRepo() {
	const appState = (window as any).appState;
	const git = (window as any).git;
	const RepositoryClass = (window as any).Repository;

	const root = new (window as any).MockDirectoryHandle('diff-test-project');
	const origin = { scheme: 'browser', path: root.name, name: root.name };
	await (window as any).browserHandleRegistry.register(`browser://${root.name}`, root);
	const repository = new RepositoryClass(origin, appState.workspace.project.vcsFactory);
	const adapter = repository.adapter;

	await root.getDirectoryHandle('.git', { create: true });
	await repository.refresh();
	const gitFs = (adapter as any).fs;

	await git.init({ fs: gitFs, dir: '/repo', defaultBranch: 'main' });
	await gitFs.promises.writeFile('/repo/README.md', 'Line 1\nLine 2\nLine 3\n');
	await gitFs.promises.writeFile('/repo/hello.ts', 'const a = 1;\nconst b = 2;\n');
	await git.add({ fs: gitFs, dir: '/repo', filepath: 'README.md' });
	await git.add({ fs: gitFs, dir: '/repo', filepath: 'hello.ts' });
	await git.commit({
		fs: gitFs,
		dir: '/repo',
		message: 'Initial commit',
		author: { name: 'Test User', email: 'test@example.com' }
	});

	// Modify files to generate diffs.
	await gitFs.promises.writeFile('/repo/README.md', 'Line 1\nLine 2 modified\nLine 3\nLine 4 added\n');
	await gitFs.promises.writeFile('/repo/hello.ts', 'const a = 100;\nconst b = 2;\n');

	await repository.refresh();

	// The working-tree files must exist in the mock handle tree too: a
	// Document save resolves its file handle through the storage registry.
	const readme = await root.getFileHandle('README.md', { create: true });
	const readmeWritable = await readme.createWritable();
	await readmeWritable.write('Line 1\nLine 2 modified\nLine 3\nLine 4 added\n');
	await readmeWritable.close();
	const hello = await root.getFileHandle('hello.ts', { create: true });
	const helloWritable = await hello.createWritable();
	await helloWritable.write('const a = 100;\nconst b = 2;\n');
	await helloWritable.close();

	appState.workspace.project.rootOrigin = origin;
	appState.workspace.rootHandle = root;
	appState.workspace.project.hasRootPermission = true;
	appState.workspace.project.repository = repository;

	return { changes: repository.changes };
}
