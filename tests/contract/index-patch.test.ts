/**
 * Real-git regression tests for the index patch rendered by `updateIndexContent`.
 *
 * Both cases here were live bugs in the shipped patch renderer, and both are
 * reproduced against the actual `git apply --cached` the adapter shells out to —
 * not against a mock. A test that stubbed git would have passed over both.
 *
 * Scope note: these are desktop-adapter specific. `IsomorphicGitAdapter` writes
 * index blobs directly through `updateIndexContent` and never renders a patch,
 * so there is no browser-side equivalent to guard.
 */
import { expect } from 'bun:test';
import type { FileOrigin } from '@np/core';
import { SpawnGitAdapter } from '../../apps/desktop/src/renderer/SpawnGitAdapter';
import { TestRepo, createTrackedRepo, describe, indexContents, it, nodeFileAccess, runGit } from './harness';

function adapterFor(repo: TestRepo): SpawnGitAdapter {
	const origin: FileOrigin = { scheme: 'file', path: repo.path, name: 'repo' };
	return new SpawnGitAdapter(origin, (workingDir, args) => runGit(workingDir, repo.env, args), nodeFileAccess);
}

/** A repository whose only committed file is `config.json`, present but empty. */
async function emptyFileRepo(content: string): Promise<TestRepo> {
	const repo = await createTrackedRepo();
	await repo.write('config.json', content);
	const add = await repo.git(['add', '-A']);
	if (add.code !== 0) throw new Error(add.stderr);
	const commit = await repo.git(['commit', '-m', 'seed']);
	if (commit.code !== 0) throw new Error(commit.stderr);
	return repo;
}

describe('updateIndexContent: an empty index entry', () => {
	it('stages the first line typed into a file that was committed empty', async () => {
		const repo = await emptyFileRepo('');
		const newContent = '{\n  "key": "value"\n}\n';

		await adapterFor(repo).updateIndexContent('config.json', newContent);

		expect(await indexContents(repo, 'config.json')).toBe(newContent);
		// The worktree is untouched — this writes the index only.
		expect(await repo.read('config.json')).toBe('');
	});

	it('empties an index entry that had content, rather than failing', async () => {
		const repo = await emptyFileRepo('one\ntwo\nthree\n');

		await adapterFor(repo).updateIndexContent('config.json', '');

		expect(await indexContents(repo, 'config.json')).toBe('');
	});

	it('stages content into a file whose index entry holds a single line', async () => {
		// A one-line old side renders a bare `-line` body; a one-line new side
		// renders a bare `+line` body. Neither may gain or lose a line.
		const repo = await emptyFileRepo('one\n');

		await adapterFor(repo).updateIndexContent('config.json', 'two\n');

		expect(await indexContents(repo, 'config.json')).toBe('two\n');
	});
});

describe('updateIndexContent: a filename containing a tab', () => {
	// git's `diff --git` header is TAB-delimited, so a raw tab in a path splits
	// the pathspec and the patch silently writes the wrong index entry.
	const TAB = '\t';

	it('stages the intended file and leaves the tab-prefixed neighbour alone', async () => {
		const repo = await createTrackedRepo();
		const target = `ta${TAB}b.txt`;
		// A second tracked file whose name is the tab-path truncated at the tab.
		// Staging the target with an unquoted header would write THIS file.
		await repo.write('ta', 'shared\n');
		await repo.write(target, 'shared\n');
		const add = await repo.git(['add', '-A']);
		if (add.code !== 0) throw new Error(add.stderr);
		const commit = await repo.git(['commit', '-m', 'seed']);
		if (commit.code !== 0) throw new Error(commit.stderr);

		await adapterFor(repo).updateIndexContent(target, 'EDITED\n');

		expect(await indexContents(repo, target)).toBe('EDITED\n');
		expect(await indexContents(repo, 'ta')).toBe('shared\n');
	});

	it('stages a new file whose name contains a tab', async () => {
		const repo = await createTrackedRepo();
		const target = `new${TAB}file.txt`;
		await repo.write('placeholder.txt', 'x\n');
		const add = await repo.git(['add', '-A']);
		if (add.code !== 0) throw new Error(add.stderr);
		const commit = await repo.git(['commit', '-m', 'seed']);
		if (commit.code !== 0) throw new Error(commit.stderr);

		await adapterFor(repo).updateIndexContent(target, 'added\n');

		expect(await indexContents(repo, target)).toBe('added\n');
	});
});

describe('updateIndexContent: a filename containing a carriage return', () => {
	// A raw CR is a line terminator to git's own patch parser, exactly as a tab is
	// a field terminator, so an unescaped one truncates the `diff --git` header the
	// same way and the patch applies to the path *before* the CR. Unlike the other
	// awkward names, this one does not even fail loudly: when the prefix neighbour's
	// staged content happens to match the hunk's old side, `git apply --cached`
	// succeeds, reports nothing, and has written the wrong file. Sweeping all 126
	// characters a filename can hold through the real adapter, CR was the only one
	// that corrupted the index silently.
	const CR = '\r';

	it('stages the intended file and leaves the CR-truncated neighbour alone', async () => {
		const repo = await createTrackedRepo();
		const target = `pre${CR}fix.txt`;
		// A second tracked file whose name is the CR-path truncated at the CR, holding
		// content identical to the hunk's old side — the regime where the mis-applied
		// patch succeeds instead of reporting "patch does not apply".
		await repo.write('pre', 'shared\n');
		await repo.write(target, 'shared\n');
		const add = await repo.git(['add', '-A']);
		if (add.code !== 0) throw new Error(add.stderr);
		const commit = await repo.git(['commit', '-m', 'seed']);
		if (commit.code !== 0) throw new Error(commit.stderr);

		await adapterFor(repo).updateIndexContent(target, 'EDITED\n');

		expect(await indexContents(repo, target)).toBe('EDITED\n');
		expect(await indexContents(repo, 'pre')).toBe('shared\n');
	});
});

describe('updateIndexContent: a filename outside ASCII', () => {
	// A non-ASCII character has to be escaped as the BYTES that name the file, not
	// as the code point that spells it: git writes `é` (U+00E9) as its two UTF-8
	// bytes `\303\251`, and a header saying `\351` names a file git does not have.
	// This one fails loudly rather than silently, but it is the same quoting rule.
	it('stages a file whose name is not ASCII', async () => {
		const repo = await createTrackedRepo();
		const target = 'café.txt';
		await repo.write(target, 'ORIGINAL\n');
		const add = await repo.git(['add', '-A']);
		if (add.code !== 0) throw new Error(add.stderr);
		const commit = await repo.git(['commit', '-m', 'seed']);
		if (commit.code !== 0) throw new Error(commit.stderr);

		await adapterFor(repo).updateIndexContent(target, 'EDITED\n');

		expect(await indexContents(repo, target)).toBe('EDITED\n');
	});
});
