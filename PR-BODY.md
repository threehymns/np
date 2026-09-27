## Summary

A bare `--` ends git's option parsing but does **not** disable pathspec magic. So a filename that begins with `:(`, `:!` or `glob:` is parsed as a magic pathspec and resolves to a different set of paths than the user named.

The worst case is a filename that reads as a *negative* pathspec:

```text
user's file        git reads it as                    git clean -fd -- <that>
────────────────────────────────────────────────────────────────────────────────
:(exclude)base.txt "everything EXCEPT base.txt"   →   deletes every untracked file
                                                    in the repo but one named base.txt
```

Measured on a real repository (git 2.55), one adapter call — discarding a single untracked file — destroyed unrelated untracked work that existed nowhere else, with **exit code 0 and no error**:

```text
$ git status --porcelain=v1 -uall
    [??] :(exclude)base.txt
    [??] IMPORTANT_UNTRACKED.txt

$ git clean -fd -- ':(exclude)base.txt'        ← the adapter's call
    IMPORTANT_UNTRACKED.txt survives? *** NO - DATA LOSS ***
```

`:(literal)` restores the intended meaning, and is a no-op for an ordinary filename — `plain.txt` carries no prefix of its own, so `:(literal)plain.txt` still matches only `plain.txt`:

```diff
+/**
+ * Wraps `path` so git treats it as one literal path rather than a pathspec.
+ *  ...
+ * Only paths that come from the user are wrapped. The repository-wide
+ * operations pass `.` deliberately, and `:(literal).` would still mean `.` but
+ * would misdocument the intent, so those are left as they are.
+ */
+function literalPathspec(path: string): string {
+	return `:(literal)${path}`;
+}
```

Applied at all **11** call sites that take a user-supplied path, across `add` / `reset` / `rm` / `clean` / `restore` / `checkout`:

```diff
-		const res = await this.runGit(['add', '--', filepath]);
+		const res = await this.runGit(['add', '--', literalPathspec(filepath)]);

-		const cleanRes = await this.runGit(['clean', '-fd', '--', filepath]);
+		const cleanRes = await this.runGit(['clean', '-fd', '--', literalPathspec(filepath)]);

-			const res = await this.runGit(['reset', 'HEAD', '--', ...paths]);
+			const res = await this.runGit(['reset', 'HEAD', '--', ...paths.map(literalPathspec)]);

-		const cleanRes = await this.runGit(['clean', '-fd', '--', ...removable]);
+		const cleanRes = await this.runGit(['clean', '-fd', '--', ...removable.map(literalPathspec)]);
```

The two repo-wide calls — `rm --cached -r -- .` and the `restore … .` inside `discardAll` — are **deliberately left alone**. `:(literal).` would still mean `.`, but wrapping it would misdocument that the `.` is intentional.

This is not a new idea to this file: `discardAll` already built `:(top,exclude,literal)` for exactly this class of problem, and its own comment explains why. The rule was known and applied in one place only.

## Evidence

- **Before** — the new contract test, against the pre-fix adapter. Six of nine fail, and they fail in the ways the probe predicted:

```text
(fail) stageFile stages only the named file, not every untracked file
(fail) discarding an untracked magic-named file leaves other untracked files alone
(fail) discarding a staged change to a magic-named file discards only that file
(fail) discarding unstaged edits in a magic-named file preserves other worktree edits
(fail) unstageFile unstages only the named magic-named file
(fail) discardAll removes the enumerated untracked files, magic-named ones included

(pass) stageFile still stages an ordinary filename
(pass) discardAll leaves tracked files alone
(pass) an ordinary filename is unaffected end to end

 3 pass
 6 fail
```

The three that pass are the ordinary-filename guards — they pass *before* the fix, which is what makes them meaningful: they prove the regression pins the magic case without changing ordinary behaviour.

- **After** — all twelve green:

```text
 12 pass
 0 fail
 29 expect() calls
```

Full suite and typecheck against the master baseline of 1312 pass / 0 fail / 0 errors:

```text
 1324 pass          # 1312 baseline + the 12 added here
 4 skip
 0 fail

svelte-check found 0 errors and 1 warning in 1 file   # the 1 warning is pre-existing
```

### The rest of the damage, measured

All of these are the same one-line root cause. Each row is "operate on **one** file, observe the others":

| adapter call (raw pathspec) | what actually happened |
|---|---|
| `git add -- ':(exclude)base.txt'` | staged **all five** untracked files |
| `git clean -fd -- ':(exclude)base.txt'` | deleted the bystander — **data loss** |
| `git checkout HEAD -- ':(exclude)base.txt'` | discarded **every** staged change |
| `git reset HEAD -- ':(exclude)base.txt'` | unstaged the bystander too |
| `git restore --worktree -- ':(exclude)base.txt'` | discarded the bystander's worktree edits |
| `git rm --cached -q -- ':(exclude)base.txt'` | silently a no-op |

## Merge Danger

**Door:** two-way. No schema, no migration, no persisted state. Reverting the commit restores the previous behaviour exactly; the test and the six updated arg assertions revert with it. Nothing outside `SpawnGitAdapter` changes.

**Blast Radius:** the desktop engine only, and only for filenames beginning with `:(`, `:!`, or `glob:` — a path that the browser engine (`isomorphic-git`, a JS API with no pathspec parsing) never had a problem with.

Two things worth a reviewer's attention:

- **`git show` is deliberately untouched.** `readGitObject` builds `` `:${filepath}` `` and passes it to `git show`, where magic *also* applies. It is not fixed here. That call site needs a different treatment (a blob OID rather than a pathspec), and mixing it in here would widen the blast radius of a data-loss fix for no gain. Left as a known follow-up.
- **A directory path still works.** git treats a pathspec naming a directory as "everything under it", and the wrap has to preserve that or staging a folder would silently stop working. Three cases pin it — `stageFile('src')` stages `src/a.txt` *and* `src/deep/b.txt` while leaving a sibling untracked, `unstageFile('src')` unstages the tree beneath it, and discarding an untracked directory removes it without touching a sibling. These are in the same file as the magic cases, because the risk is the wrap over-narrowing rather than under-narrowing.
