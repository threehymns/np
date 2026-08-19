import git from 'isomorphic-git';

export interface RenameResolutionParams {
	fs: any;
	dir: string;
	headCommit: string;
	filepath: string;
	stagedOid?: string | null;
	workdirContent?: string;
}

export function isENOENT(err: any): boolean {
	if (!err) return false;
	if (err.code === 'ENOENT') return true;
	if (err.name === 'NotFoundError') return true;
	if (err.name === 'ENOENT') return true;
	return false;
}

/**
 * Searches the HEAD tree for a renamed file candidate when the target filepath is not present in HEAD.
 * Attempts exact blob OID matching first, then falls back to heuristic matching of deleted files in the working directory
 * based on path components (basename, directory, extension).
 */
export async function resolveRenamedHeadContent(params: RenameResolutionParams): Promise<string | null> {
	const { fs, dir, headCommit, filepath, stagedOid, workdirContent } = params;
	let targetOid: string | null = stagedOid || null;

	if (!targetOid) {
		let buffer: Uint8Array | string | null = null;
		if (workdirContent !== undefined) {
			buffer = workdirContent;
		} else {
			try {
				buffer = await fs.promises.readFile(`${dir}/${filepath}`);
			} catch (e: any) {
				if (!isENOENT(e)) {
					throw e;
				}
			}
		}
		if (buffer !== null && buffer !== undefined) {
			const res = await git.hashBlob({
				object: typeof buffer === 'string' ? new TextEncoder().encode(buffer) : buffer
			});
			targetOid = res.oid;
		}
	}

	let matchedHeadOid: string | null = null;
	const deletedCandidates: Array<{ path: string; oid: string; score: number }> = [];
	const targetBasename = filepath.split('/').pop() || filepath;
	const targetDir = filepath.includes('/') ? filepath.substring(0, filepath.lastIndexOf('/')) : '';

	await git.walk({
		fs,
		dir,
		trees: [git.TREE({ ref: headCommit })],
		map: async (walkPath, entries) => {
			// Absent entry: signal the walker that the entry is gone (unlike the bare
			// `return` below, null marks the entry absent — for the root that prunes
			// the entire descent, so the two returns must never be conflated).
			if (!entries || !entries[0]) return null;
			const type = await entries[0].type();
			if (type === 'blob') {
				const oid = await entries[0].oid();
				if (oid) {
					// One presence probe per walk path: a blob that still exists in the
					// worktree is an addition, not a rename, and must not supply a
					// baseline, so both the exact-OID match and the deleted-candidate
					// scoring only apply to absent sources.
					let absent = false;
					try {
						await fs.promises.stat(`${dir}/${walkPath}`);
					} catch (e: any) {
						if (!isENOENT(e)) {
							throw e;
						}
						absent = true;
					}
					if (absent) {
						// Exact OID match: only meaningful when the candidate source is
						// actually gone from the worktree. A still-present blob (e.g. an
						// identical-content copy) is an addition, not a rename, and must
						// not supply a baseline.
						if (targetOid && oid === targetOid && !matchedHeadOid) {
							matchedHeadOid = oid;
						}
						let score = 0;
						const walkBasename = walkPath.split('/').pop() || walkPath;
						const walkDir = walkPath.includes('/') ? walkPath.substring(0, walkPath.lastIndexOf('/')) : '';
						if (walkBasename === targetBasename) score += 3;
						if (walkDir === targetDir) score += 2;
						const walkExt = walkBasename.includes('.') ? walkBasename.substring(walkBasename.lastIndexOf('.')) : '';
						const targetExt = targetBasename.includes('.') ? targetBasename.substring(targetBasename.lastIndexOf('.')) : '';
						if (walkExt && walkExt === targetExt) score += 1;
						deletedCandidates.push({ path: walkPath, oid, score });
					}
				}
			}
			// Returning null would mark the entry as absent and prune the walk (for the
			// root that aborts the whole descent); undefined keeps the walk descending.
			return;
		}
	});

	if (!matchedHeadOid && deletedCandidates.length > 0) {
		deletedCandidates.sort((a, b) => b.score - a.score);
		const bestCandidate = deletedCandidates[0];
		const isUnique = deletedCandidates.length === 1 || bestCandidate.score > deletedCandidates[1].score;
		if (bestCandidate.score > 0 && isUnique) {
			matchedHeadOid = bestCandidate.oid;
		}
	}

	if (matchedHeadOid) {
		const { blob } = await git.readBlob({
			fs,
			dir,
			oid: matchedHeadOid
		});
		return new TextDecoder().decode(blob);
	}

	return null;
}
