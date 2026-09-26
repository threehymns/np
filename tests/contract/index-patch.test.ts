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

describe('updateIndexContent: the rendered hunk header', () => {
	// The cases above all assert only the staged result, which is why a hunk
	// header with a wrong line count could pass every one of them: the ranges
	// are the part of the patch git reads before it looks at any content. A
	// wrong count makes `git apply` reject the whole patch as `corrupt patch at`,
	// so a count bug is a staging failure that no result-level assertion sees.
	// These cases capture the bytes the adapter actually hands to git and read
	// the ranges back out of them.
	function capturingAdapter(repo: TestRepo): { adapter: SpawnGitAdapter; patches: string[] } {
		const origin: FileOrigin = { scheme: 'file', path: repo.path, name: 'repo' };
		const patches: string[] = [];
		// The adapter renders the patch to a temp file and applies that file, so
		// the bytes git reads are on disk rather than on stdin. Recording every
		// write into a path holding a patch keeps the capture independent of the
		// adapter's internal temp-file naming.
		const fileAccess = {
			...nodeFileAccess,
			writeFile: async (path: string, content: string): Promise<void> => {
				if (content.startsWith('diff --git ')) patches.push(content);
				return nodeFileAccess.writeFile(path, content);
			}
		};
		const adapter = new SpawnGitAdapter(origin, (workingDir, args) => runGit(workingDir, repo.env, args), fileAccess);
		return { adapter, patches };
	}

	/** Run one `updateIndexContent` while capturing the patch git was given. */
	async function patchFor(
		repo: TestRepo,
		target: string,
		content: string,
		seed = 'SEED\n'
	): Promise<string> {
		await repo.write(target, seed);
		const add = await repo.git(['add', '-A']);
		if (add.code !== 0) throw new Error(add.stderr);
		const commit = await repo.git(['commit', '-m', 'seed']);
		if (commit.code !== 0) throw new Error(commit.stderr);

		const { adapter, patches } = capturingAdapter(repo);
		await adapter.updateIndexContent(target, content);
		if (patches.length === 0) throw new Error('no patch was passed to git apply');
		return patches[0]!;
	}

	/** The `-old,+new` ranges of every `@@` header, as `[old, new]` pairs. */
	function hunkRanges(patch: string): Array<[string, string]> {
		return [...patch.matchAll(/^@@ -(\S+) \+(\S+) @@/gm)].map((m) => [m[1]!, m[2]!]);
	}

	it('counts the lines of an edited file in the header it hands git', async () => {
		const repo = await createTrackedRepo();

		// The default seed is one line, so the old side ranges to `1` and the new
		// side to `1,3`: 'a\nb\nc\n' is three lines, because a trailing newline
		// ends the last one rather than starting a fourth. Collapsing either
		// range to `0,0` is what made `git apply` answer `corrupt patch`.
		const patch = await patchFor(repo, 'src.txt', 'a\nb\nc\n');
		expect(hunkRanges(patch)).toEqual([['1', '1,3']]);
	});

	it('counts a final line that has no trailing newline', async () => {
		const repo = await createTrackedRepo();

		// 'a\nb' is two lines, and the missing trailing newline is the case a
		// naive newline count reports as one, which would emit `1,1`.
		const patch = await patchFor(repo, 'src.txt', 'a\nb', 'a\nb\nc\nd\n');
		expect(hunkRanges(patch)).toEqual([['1,4', '1,2']]);
	});

	it('ranges an emptied file to zero on the new side only', async () => {
		const repo = await createTrackedRepo();

		// The seeded side is three lines and stays `1,3`; the side emptied by the
		// edit has no content left, which is `0,0` and a body of only `-` lines.
		// A single-line file instead ranges to a bare `1` on the surviving side,
		// which is git's own convention and the case most easily flattened.
		const patch = await patchFor(repo, 'src.txt', '', 'a\nb\nc\n');
		expect(hunkRanges(patch)).toEqual([['1,3', '0,0']]);
	});

	it('ranges a one-line file to a bare count on both sides', async () => {
		const repo = await createTrackedRepo();

		// git writes a single-line range as `1` with no `,count` suffix, and both
		// sides here are one line. Reading these back as `1,1` would pass a
		// substring match while being a range git never emits.
		const patch = await patchFor(repo, 'src.txt', 'z\n', 'q\n');
		expect(hunkRanges(patch)).toEqual([['1', '1']]);
		expect(patch).toContain('@@ -1 +1 @@');
	});
});
