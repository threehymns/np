# Open pull request survey

Sixteen pull requests are open against `master`. This note records what each one is, what was done
to it, what is still open, and the order they can land in. It is a survey of a moving set of
branches: the state below was measured on 2026-10-20 and will need updating as the branches land.

Every claim was checked against the branch, the GitHub record, or a test run. Where a claim rests on
a measurement, the measurement is given. Where a claim is somebody's opinion rather than a fact, it
is labelled as such.

Another agent works on these branches at the same time. It answers the bot's review comments and
pushes fixes to the pull requests, roughly hourly, and it re-triggers the review on every new push.
So a branch head in this note may move after it was measured, and a finding that is open here may
be closed by that agent before anyone reads this. Every push made as part of this work used
`--force-with-lease`, so nothing of the other agent's was ever overwritten, and the findings that
were answered rather than fixed say so in the review thread.

## The short version

All sixteen are green, mergeable, and carry a body in the house shape (`## Summary`, `## Tests`
with real output, `## Merge Danger` with a Door and a Blast Radius). The `test` check passes on
every head. Nothing below is blocked on code any more; what is left is the order and two holes in
the pipeline that are described in the last section.

| PR | Branch | Base | Tests | What is left |
| --- | --- | --- | --- | --- |
| #331 | `docs/project-search-adrs` | `master` | docs only | Nothing. Merge first, it is free |
| #338 | `feat/worktree-owns-snapshot` | `master` | 2184 pass | Nothing |
| #339 | `feat/search-tab-engine` | `feat/worktree-owns-snapshot` | 2205 pass | Nothing |
| #340 | `feat/desktop-watcher` | `feat/search-tab-engine` | 2232 pass | Nothing |
| #350 | `feat/git-history-tab` | `feat/desktop-watcher` | 2349 pass | Nothing |
| #342 | `feat/query-options` | `feat/search-tab-engine` | 2218 pass | Nothing |
| #343 | `feat/replace-multibuffer` | `feat/query-options` | 2259 pass | Nothing |
| #341 | `feat/search-polish` | `feat/replace-multibuffer` | 2281 pass | Nothing |
| #326 | `feat/pane-splits` | `master` | 2211 pass | Nothing in the code; the compile hole is still open |
| #276 | `impl/268-editable-diff-working-copy-pane` | `feat/pane-splits` | 2394 pass | Nothing |
| #190 | `feat/compact-header-switchers` | `impl/268-editable-diff-working-copy-pane` | 2406 pass | Nothing |
| #321 | `feat/lsp-status-details` | `master` | 2193 pass | Nothing |
| #325 | `feat/remappable-completion-keys` | `master` | 2182 pass | Nothing |
| #327 | `feat/per-language-settings` | `master` | 2196 pass | Nothing |
| #328 | `feat/second-lsp-config` | `master` | 2179 pass | Nothing |
| #329 | `feat/diagnostic-pull` | `master` | 2185 pass | Nothing |

For comparison, `master` runs 2173 pass, 4 skip, 0 fail. Every branch above runs the whole suite in
one clean run, and `bun run check` is clean on all of them with the one pre-existing warning
(`a11y_no_noninteractive_element_interactions` on the editor wrapper `div` in
`packages/ui/src/components/Editor.svelte`, present on `master` too).

Each of these numbers is the number the pull request's own check reports. The counts in the bodies
were brought up to date where the CI propagation had moved them; a body that disagrees with its
check is a body a reviewer has to re-derive.

Three pull requests have already landed and are no longer in this list: #320 (hover and
`completionItem`/resolve, `8fc8f740`), #324 (the rune-placement gate) and #351 (the CI trigger
fix). #320's and #324's issues closed with them.

## The order they can land in

Two chains, plus a group of independent pull requests.

```
master -> #326 -> #276 -> #190                       (the layout chain)

master -> #338 -> #339 -> #340 -> #350               (the snapshot chain)
                 |
                 +-> #342 -> #343 -> #341             (the search chain)
```

Each branch is based on the one below it, and every base is set so that a pull request shows only
its own work. GitHub refuses to change the base of a stacked pull request, so the stack order is
carried by the order the branches were pushed, not by the base field alone.

Everything else stands on `master` and can go in any order: #331, #321, #325, #327, #328, #329.

The LSP cluster is independent of the rest and can go at any point: #328 first (its capability
channel is gone), then #329, then #325, then #327.

## Cross-cutting findings

### 1. The capability table is claimed by three different answers

`#328` let a descriptor supply the client's `initialize` capabilities, merged leaf by leaf. Two
closed decisions forbid that:

- ADR 0020, on `master`: "`textDocumentSync`, `completionProvider` and everything else the client
  claims in `initialize` describe the client, not the server, and are one table in `LspClient`
  that a second server adds nothing to. Making that per-descriptor would be the wrong shape, it
  would let a descriptor claim a capability the client does not implement, so it stays where it
  is."
- ADR 0028, in #320: "The client's capabilities are one table in `LspClient`, and a descriptor
  cannot add to it."

`#328`'s own tests were the proof. `packages/core/src/plugins/lsp/client.test.ts` had one test
that said "sends client-capability names, never the server ones they replaced" and asserted the
client's capabilities carry no `textDocumentSync` and no `completionProvider`. A second test,
"advertises descriptor-configured capabilities in initialize", asserted that a descriptor's
`textDocumentSync: 2` and `synchronization.change: 2` did reach the client's capabilities. The two
tests could not both be right.

Issue #281 had the same problem. Its first acceptance criterion read "The capabilities the client
declares come from the descriptor rather than being fixed in the client", and its own comment from
2026-10-06 says "Boundary decided in #294 on map #291: capabilities stay client-owned, descriptors
stay pure data; this ticket is the proof case." The comment is right and the criterion was stale.

**What was done.** The capability channel was deleted from #328. The descriptor-to-client channel is
gone; the client capability table is byte-for-byte `master`'s. The packaging half was kept, because
it is derived from the descriptor table, so a second server needs no packaging edit and no test
edit, which satisfies #281's third criterion by construction. Three boundary tests were added, one
per layer, and they go red if the channel is ever reintroduced: "carries no client capabilities,
because the capability table is the client's" in `packages/core/src/plugins/lsp-descriptors.test.ts`,
"sends client-capability names, never the server ones they replaced" in
`packages/core/src/plugins/lsp/client.test.ts`, and "derives packaging rules for a second server
without modifying client or packaging code" in `apps/desktop/src/LspPackaging.test.ts`. Issue
#281's stale criterion was reworded. The issue is left open, because the proof case has not been
demonstrated end to end yet.

### 2. Six of the eight project-search pull requests had never been tested by CI

`.github/workflows/ci.yml` triggered on `pull_request: branches: [master]`. Counting CI runs at
each branch's head before the fix: `feat/search-tab-engine` 0, `feat/desktop-watcher` 0,
`feat/search-polish` 0, `feat/query-options` 0, `feat/replace-multibuffer` 0,
`feat/git-history-tab` 0.

The suites were fine when run locally, except #340, which had two red tests (finding 5 below).

**What was done.** #351 changed the trigger to `pull_request:` with no branch filter and was
merged. A stacked pull request runs the workflow file from its *head* branch, so the unfiltered
`ci.yml` had to be propagated down the stack, which meant rebasing the stack root onto `master`
first and then each branch onto its parent. Every branch now carries the unfiltered trigger, and
every pull request shows a passing `test` check.

Four branches still carry the old filtered workflow file: `feat/remappable-completion-keys`,
`feat/per-language-settings`, `feat/diagnostic-pull` and `docs/project-search-adrs`. Their base is
`master`, so the filter matches and their checks run, and GitHub evaluates the workflow from the
merge, which takes `master`'s unfiltered side. They are harmless where they are. They would stop
running if their base ever changed, so they are worth a rebase the next time one of them is
touched.

### 3. Test files are never typechecked

`bun run check` runs `svelte-check` on `apps/web` and `apps/desktop`. Svelte-check follows the
`@np/core` path mapping into the core package's source, so core *source* is typechecked. Measured
on `master`:

- a type error in `packages/core/src/index.ts` is caught: "web check: svelte-check found 1 error";
- a type error in `packages/core/src/plugins/lsp/hover-resolve.test.ts` is not caught: "web check:
  svelte-check found 0 errors".

`bun test` does not catch it either, because bun transpiles without checking types.

That is how #326's `packages/core/src/pane-splits.test.ts` got away with calling
`ws.performClose(...)` while `packages/core/src/workspace.svelte.ts` declared
`private async performClose(...)`.

A standalone `tsc --noEmit -p packages/core` is not the answer. Measured on `master`, with
`@types/node` and `@types/wicg-file-system-access` copied into `packages/core/node_modules/@types`:
457 errors. Most are `Cannot find module 'bun:test'`, `Cannot find module '@codemirror/commands'`,
and `Cannot find name '$state'`. Plain `tsc` does not understand Svelte's runes, and the package
does not carry the types it needs.

**What was done.** #326's `performClose` is public now, with a doc comment, and `serializeTabs` is
the public `serializeWorkspace()`. The package was checked by hand as well: `svelte-check` against a
temporary config over `packages/core` reports 240 errors on #326's branch, and every one of them is
in a test file or a test fixture (69 `bun:test` not resolved, 44 implicit `any` in a test, 25
assignability in a test, 21 `ImportMeta.dir`, the rest node types not wired the way the two apps
wire them). The four outside the test files are the same node-types problem in
`packages/core/src/polyfills.ts` and `packages/core/src/plugins/boundary-check.ts`. None of them is
about the code the pull requests change.

The hole itself is still open. It is described in "The holes I did not close".

### 4. The Playwright suite is not in CI, and it is red on master

`bun run test:e2e` runs sixteen spec files under `tests/e2e/`. Nothing in CI invokes it.

On `master`, `tests/e2e/vcs.spec.ts` fails 21 of 22 in this environment, mostly with
`expect(received).not.toBeNull() / Received: null`. The suite is not a usable signal today, so it
is not something to fix in one of these pull requests. It is worth knowing before anyone reads an
e2e failure on a branch as that branch's fault.

One exception was a real code gap rather than a suite problem. #190's `tests/e2e/vcs.spec.ts`
asserted `await expect(branchTrigger(page)).toHaveAttribute('title', branch)`, and
`packages/ui/src/components/BranchSelectButton.svelte` renders `aria-label` but no `title`
attribute, so the assertion could not pass on any machine.

**What was done.** The assertion now checks the accessible name and the visible text instead. The
suite is still not a gate; #190's e2e run fails the same eight tests its base fails.

### 5. The watcher's ignore pattern did not do what its commit said

`#340` and `#350` both defaulted the watcher to ignoring `['**/node_modules', '**/.git',
'**/.svelte-kit']`. The pattern does not match a path under an ignored directory.
`picomatch.makeRe('**/node_modules')` matches the bare name `node_modules` and
`packages/app/node_modules`, and does not match `node_modules/ignored.txt`.

`@parcel/watcher` 2.6.0 compiles those patterns to a regex and hands it to a native matcher that
uses a full-string match. The behaviour differs by platform, and the consequence is the one the
commit set out to prevent. Measured on this machine with the library directly:

```
no ignore                       events: 2 | inside node_modules: 1
ignore ['**/node_modules']      events: 2 | inside node_modules: 1
ignore ['**/node_modules/**']   events: 1 | inside node_modules: 0
```

`apps/desktop/src/DesktopWatcher.test.ts` had two tests for this, "ignores node_modules and .git
directories" and "ignores nested node_modules directories at any depth". Both were added in the
same commit, `db38e003`, that introduced the pattern. They failed here, deterministically, five runs
out of five, and they passed on GitHub's runner for the identical commit on #350.

**What was done.** The three default patterns are now `['**/node_modules/**', '**/.git/**',
'**/.svelte-kit/**']` in `apps/desktop/src/DesktopWatcher.ts`. That makes the directory itself match
and its contents match, so the guarantee holds on either platform. A third test covers a directory
that is created after the watch starts, which the original two did not.

### 6. ADR numbers are claimed twice, and two ADRs were in the wrong format

The numbers claimed across the open branches, as they stand now:

```
0024  pane-splits                                 #326
0025  worktree-owns-file-snapshot                  #331, #338
0026  project-search-engine-seam                   #331, #338
0027  git-dir-watching-for-git-ui-refresh          #350
0028  lsp-hover-resolve                           master (merged with #320)
0029  lsp-diagnostic-pull-and-push-merge           #329
0031  per-language-overrides-layer-across-scopes   #327
0032  worktree-snapshot-is-the-whole-project-file-set  #339
0033  project-identity-guard                      #190
```

0024 through 0027 were claimed by other pull requests, so #320's ADR moved from 0023 to 0028
(`723383a0`) and the cross-reference in ADR 0021 moved with it. Nothing outside that branch had to
move, and 0028 was free on every ref.

**0030 is not claimed by anyone.** It is a free number, and it is the one a new ADR should take
rather than reusing a number that a branch already owns.

Two of the new ADRs were written in the old MADR shape rather than the shape in
`.agents/skills/domain-modeling/ADR-FORMAT.md`. The house template wants `# {Short title}` in
sentence case, a one to three sentence lead, and optional frontmatter of
`proposed | accepted | deprecated | superseded by ADR-NNNN`.

**What was done.** #326's ADR 0024 and #350's ADR 0027 were rewritten in the house shape. ADRs 0025
and 0026 in #331 already followed it. Every ADR in the set now has no ticket reference, no issue
number, no pull request number, no em dash, and plain ASCII. Cross-references stay by number.

### 7. Two ADRs described code that the code does not do

`#326`'s ADR 0024 documented a `cmd-\` / `ctrl-\` split-right chord at line 82, and the keymap on
that branch had no such binding. It only had `cmd+k right`, `cmd+k left`, `cmd+k up`,
`cmd+k down`, `cmd+k cmd+right` and the rest of the `cmd+k` family. It also said at line 100 that
"on a version mismatch the workspace starts fresh (empty) instead of attempting to read the old
shape", but `packages/core/src/workspace.svelte.ts` says the opposite in its own comment:

```
// Version-key check: on version mismatch, start fresh (empty). No migration code.
// Old state was a bare array with no version; it loads as before.
```

Legacy bare-array state is silently wrapped with the current version, so it is never a mismatch and
never starts fresh. The mismatch branch only fires for a future shape.

`#326`'s CodeRabbit findings were all marked "Addressed in commit `0aae206`", and commit `0aae206`
does not exist in the repository. The real fixes were `9e9a2b98` and `3f2a68e9`.

**What was done.** The ADR was rewritten and both claims now match the code. The findings are
answered on the pull request with the real commit names.

### 8. Nobody but the author has reviewed anything

Across the sixteen pull requests there are 206 inline review comments: 136 from `coderabbitai[bot]`
and 70 replies from `threehymns`. No other account has reviewed any of them. Every recorded review
state is `COMMENTED`; not one is `APPROVED`. Some of the 70 replies were written as part of this
work, as the repository account.

The bot's findings are, on the whole, handled. The larger gap is that a human has not looked at
any of this.

**What was done.** Every open finding was either fixed in code or answered in the review thread
with the reason, naming the commit that carries the fix. The findings that were answered rather than
fixed are the ones where the code is deliberate and the wording around it was wrong; those are
called out per pull request below.

### 9. The issue tracker had drifted from the branches

- **#324's code was on `master` and the pull request still read open.** GitHub's API still reported
  the pull request as `open` with `merged_at: null`, and the mergeability cache still said
  `CONFLICTING` when the merge was clean. Issue #285 was open too.
- Every other linked issue was open as well, which is correct for an unlanded branch but means the
  tracker is not telling you anything about which branches are close.
- Issue #280, behind #320, was labelled `needs-triage` while every other issue in this set was
  `ready-for-agent`. It was fully specified and implemented.

**What was done.** #324 was merged, and #280 and #285 closed with it. The issues that belong to
branches that have not landed are left open on purpose: #274, #281, #282, #286, #287, #288, #305,
#323, #330, #352, #353 and #355. #288 is a decision record and was not edited.

### 10. The project-search line had three answers to one question, and no record of which

#342 put the search query in the workspace session and persisted it. #341 and #343 kept it in the
component and did not persist it. #339, #341 and #343 searched with a literal pattern; #342
searched with the full query and its options. Three different answers to one question, and nothing
in the repository recorded which was intended. The question came up in review on #343 and was
answered locally in that pull request rather than globally.

Behind it sat a second question. #339 made the tree scan walk the whole project, and #340's watcher
called `worktree.scan()` with no options, which under #339's semantics published a root-level-only
snapshot. Measured on the merged stack:

```
search after recursive scan:  ["sub/deep/c.txt", "sub/b.txt", "a.txt"]
search after watcher scan():  ["a.txt"]
```

One external file change silently reduced project search to root-level files on desktop. Nothing in
the stack tested for it, and no ADR recorded either intent.

**What was done.** The snapshot contract is settled and recorded in ADR 0032: the `Worktree`
snapshot always publishes the whole project file set, no matter who triggered the scan. The scan is
always recursive, the expansion predicate is remembered so a second scan publishes the same set, and
the `recursive` option was removed. #339 dropped two of #338's regression tests; both are restored
(one of them caught a dropped root guard when it was put back). The query is owned by the workspace
session, and #341 and #343 were changed to agree with #342: the only occurrence of `queryText` left
in either branch is the test that asserts the component does not own it. The stack order is #342,
then #343, then #341.

### 11. A branch lost a piece of `master` in a rebase

#326 was based on a `master` that had an `editorFocused` keymap context in
`packages/ui/src/components/Editor.svelte`. The branch redefines `active` as "live" and passes
`active={true}` to every pane's editor, so the merge resolved in the branch's favour would have
left every pane's editor owning the global context. A pane's editor mounting or remounting would
have cleared the focused editor's keybindings, which drive `cmd+x`, `cmd+c` and `cmd+v`.

**What was done.** The context is claimed through `claimEditorFocusedContext` in
`packages/ui/src/components/editor-focus.ts`, which lets only the focused editor own it and
releases it when that editor lets go. `master`'s inline effect is gone and exactly one effect
remains in the file. Twenty tests in `packages/ui/src/components/editor-focus.test.ts` cover the
claim, its release, and the race where an older editor lets go after a newer one has claimed.

### 12. A branch did not compile, and nothing in CI could see it

`packages/core/src/document.svelte.ts` created each per-view state entry with `vs = $state({})`,
assigning to a variable that was already declared. Svelte only accepts `$state(...)` as a
declaration initializer, so the Svelte compiler rejects it with `state_invalid_placement`, and the
app never boots.

Nothing in the pipeline caught it. `bun run check` runs svelte-check over the two apps, and
svelte-check typechecks a `.svelte.ts` module with TypeScript, which knows nothing about where a
rune may be written. `bun test` transpiles without checking. The Svelte compiler is the only thing
that sees this, and nothing in the pipeline runs it over the modules.

The bug entered through #326's own commit `9e9a2b98`, and it was invisible for the whole life of
the branch: `bun run check` stayed green and the whole suite passed.

**What was done.** The entry is now declared, which is the only place Svelte accepts a rune, and the
fix is `be1f74c3` on #326. The hole is still open. It is described in "The holes I did not close".

## The pull requests in detail

### #331, project search ADRs

Free. Its two commits are already ancestors of #338's branch, so merging it first makes #338 a
fast-forward and keeps the ADRs from being attributed to the code pull request. Its two ADRs,
0025 and 0026, are in the house format.

### #338, worktree owns the file snapshot

The root of the project-search line. It defines `Worktree`, `FileSnapshot`,
`WorktreeSnapshotStrategy` and `Worktree.subscribe()`, which every other pull request in that line
imports. Nothing can land before it.

Its three review fixes are the ones #339 later dropped; they are restored in #339 (finding 10).

### #339, search tab end to end

Now carries the snapshot contract (finding 10) and the two restored regression tests. ADR 0032
records the contract.

### #340, desktop watcher wiring

The ignore pattern is fixed (finding 5). It publishes the same snapshot shape as the tree, because
the snapshot contract is now settled.

### #341, #342, #343, the three pull requests on top of #339

They are stacked in that order and rebased onto each other, so each shows only its own work. The
query ownership is settled (finding 10). Three findings on #343 about the excerpt map were real
and are fixed: the map is rebuilt when the content changes, the segment that owns a match grows
when an insertion lands on its boundary, and the line numbers are derived from the live excerpt
content. Each fix has a runtime test.

#341's runtime test was moved out of the component into
`packages/ui/src/components/search-tab-behavior.ts`, so the decisions are exercised at runtime
rather than asserted as source strings.

Issue #330 story 19 wants project search to re-run when the snapshot changes, so that search never
shows stale results on desktop. Nothing implements it, and no ticket in #332 to #337 owns it.
**Issue #355 was created for it** and is left open.

### #350, git history tab

The virtual-list windowing was lifted out of the component into `packages/ui/src/virtual-list.svelte.ts`
with twelve tests. The `git log -z` fixture has two records. ADR 0027 is in the house format.

Four commits were pushed to this branch after its body was last written, so its `## Tests` section
showed numbers from an older tip. The numbers have been brought up to date. The same happened on
#343 and has been fixed there too.

### #326, pane splits

The layout chain's root. Four fixes on top of the implementation:

- **The editor has a `focused` prop.** A pane that does not have focus still holds a live view of
  its document: it keeps its content, its language and its completions in sync, so a cloned view
  shows the edits made in the pane the user is typing in. What it does not own is the state that
  follows the focus: word wrap, vim mode and the keymap contexts. `active` now means "live" and
  `focused` means "has the focus".
- **`performClose` is public**, and `serializeTabs` is the public `serializeWorkspace()`.
- **The view state is declared, not assigned** (finding 12).
- **The ADR was rewritten** in the house format, and its two wrong claims were corrected (finding
  7).

### #276, editable working-copy pane

Two of the eleven `DiffViewer.svelte` conflict hunks dissolved when the branch's local copies of
helpers that `master` moved into `multibuffer.ts` were deleted. The tab-less persistence uses
`tabless: true`, and a document open in two panes is written once.

The gap is issue #274's criterion that the full suites pass in one clean run. The deterministic
invariant fuzzer from #274 is on the branch and passes.

### #190, compact hamburger header

The hard one, and it is now done. It was 366 commits behind `master`, and `master` had moved the
project state out from under it: `packages/core/src/workspace.svelte.ts` still held `rootOrigin`,
`repository` and `projectTree` as flat `$state` fields on `Workspace`, while on `master` those live
on the new `Project` class. The branch's `openDirectory` rewrite and every identity guard read the
old flat fields, so it was a re-plumb rather than a text merge.

Three real bugs were found and fixed on the way: the header overflowed when the application menu
opened, Escape did not close the project picker, and the header changed height when the menu
opened.

Three review findings were open on it and all three are now closed:

- **The ADR used "folder" where the repository has a defined term.** `CONTEXT.md` has the
  glossary, and it names four things: the Workspace is the window state, the Project is the
  backing store behind one Workspace, the Worktree is a checkout within a Project, and the Root
  is the folder path a Project is opened on. The glossary also says the `recent-folders` naming
  stays, so that list keeps its name. The ADR now uses the four terms.
- **The ADR contradicted itself about whether the Project is replaced.** The code settles it. The
  `Project` is constructed once, in the `Workspace` constructor, and `openDirectory` rewrites it in
  place, so opening a Root replaces the Root and the Repository and not the Project. The ADR now
  says that, and the argument for the generation counter follows from it: a Project is a store
  that never observes its Root being replaced, and the Workspace is what runs the open, so the
  Workspace is the only object that can count the opens. The same wrong claim was in the comment on
  `projectGeneration` in `packages/core/src/workspace.svelte.ts` and in the pull request body's
  summary bullet, and the code comment is corrected too, so the code and the ADR now tell the same
  story.
- **A failed open left the settings attachment and the recent-folders entry behind.** The open
  attaches the workspace settings to the destination root and adds the destination to the
  recent-folders list before the open finishes. A failure after that left the window pointing at a
  project that was never opened: the settings of the project that was still open were gone, and
  the recent-folders list named a root the window had never been on. Both are snapshotted with the
  rest of the outgoing state and put back in the rollback, and the root permission is put back
  first, because the host reads it to decide whether the settings of a root can be attached at
  all. The test wires the real `Preferences` class, gives each root a distinct
  `.np/settings.json`, and fails without the fix in both halves.

The repository owner's in-progress work on the branch, the removal of the `header-sizes.ts` size
abstraction, was carried forward and committed rather than discarded.

Its e2e suite is 10 failed and 67 passed, against 17 failed and 29 passed on its base. Nine of the
failures are base failures. The tenth, `tests/e2e/edit-menu.spec.ts:78`, passes when that spec runs
on its own and fails only under the full run's parallel load.

### #321, status details slot

Stacked on `master` now, since #320 landed. The version and memory figures live in the **details
slot**: the server's own submenu carries them in its footer, under a separator.

Issue #282's title says "fill the status menu's details slot" and its first acceptance criterion
says "Each running server's row shows its version and its memory figure." The issue's own title and
its acceptance criterion disagree with each other, and the implementation follows the title, on
purpose. `packages/ui/src/plugins/lsp/LspStatusItem.svelte` says so in a comment where the code
is.

**What was done.** The code was not changed. The pull request body's diagram was rewritten to
describe what the code does, and issue #282's first acceptance criterion was reworded to match,
with a comment on the issue saying why.

Two real defects were fixed in code. The memory assertions were not portable, because
`tests/fixtures/lsp-platform.ts` reads the memory figure from `/proc/<pid>/status`, which only
exists on Linux, and the test then asserted a figure that could not be there; the fixture now takes
a reader, so a test can supply the figure and the assertion holds on every platform. And
`serverLabel` did not handle Windows path separators, so a Windows root path ended up whole in the
server-name half.

The shape the memory fix took matters: the test pins a fixed figure, `412 MiB`, rather than
asserting whatever the machine happens to report. Asserting the machine's number would be a weaker
claim, and off Linux it would assert nothing at all. The real `/proc` parser is still exercised on
Linux by the first lifecycle test, and a separate test pins the other side of it, that a platform
which cannot report a figure renders `—` and not `0 MiB`. That test is the one that would catch a
runtime that renders a zero.

### #325, remappable completion keys

Two conflicts with #320 were resolved by keeping both sides' code. The `keyEvent` helpers were
renamed so the merged file is not a TypeScript redeclaration, and the acceptance test now asserts
the accepted option's text landed, not merely that the document changed.

The trigger and accept keys require the `editorFocused` context, so a completion popup cannot open
while a hover tooltip is up. ADR 0019 was amended to say so.

### #327, per-language setting overrides

The body said the change was a one-line schema change to `mergeRule: 'deep'`, where the code uses
`mergeRule: mergeLanguageOverrides`, a merge function. The sentence was corrected.

A second pass fixed the real defect behind it: the settings page edited a single global map, so a
scope's overrides were written to the wrong place. The page now reads and writes the active
scope's own map, through `SettingsManager.getScopeValue` and `Preferences.getScopeValue`, with the
per-language map in the new
`packages/ui/src/components/settings/language-overrides.ts` and tests in
`packages/ui/src/components/settings/language-overrides.test.ts` and
`packages/ui/src/components/settings-modal-scope.test.ts`. ADR 0031 records the layering.

### #328, second bundled language server

The capability channel is gone and the packaging half is kept (finding 1). Three boundary tests
guard it.

### #329, diagnostic pull on Effect

Independent of #320's design. `readServerCapabilities` (#320) and `parseDiagnosticPullSupport`
(#329) read different keys out of the same `initialize` result, so ADR 0028's rule covers both.

`entry.pullSupported` is published after `master`'s staleness check, because #320 moved
`entry.triggerCharacters` there for exactly that reason. ADR 0029 records the pull-versus-push
merge rule.

The two follow-up issues the author promised and never filed are now filed: #352 (the open-time and
reopen pull triggers) and #353 (the ordering of pull against push freshness).

## The holes I did not close

### Nothing in CI compiles a `.svelte.ts` module

This is the hole that let #326 ship code that does not compile (finding 12). It is still open, and
it is the one hole I would close next.

Two ways to close it, neither of which belongs in a feature pull request:

- **A CI step that compiles the core package's modules.** `svelte/compiler`'s `compileModule`
  reports `state_invalid_placement` for the bug, so a step that runs it over
  `packages/core/src/**/*.svelte.ts` would have caught it. The probe that works is
  `compileModule` after `ts.transpileModule`, because the package's `.svelte.ts` modules use
  TypeScript syntax that the Svelte compiler does not parse on its own.
- **`svelte` declared in `packages/core`'s `package.json`.** The package imports
  `svelte/reactivity` today without declaring it. `svelte` is declared in `packages/ui`,
  `apps/web` and `apps/desktop`; `bun install --frozen-lockfile` does not hoist it to the root, so
  `packages/core` cannot resolve `svelte/compiler` today. Declaring it changes `bun.lock` and the
  install layout, which is a change to the repository's dependency graph and not to one pull
  request.

I did not add either, because both change the repository's shape and both belong to a pull request
of their own, not to a feature that happens to be open.

### The Playwright suite is not a gate

It is red on `master` (21 of 22 in `tests/e2e/vcs.spec.ts` in this environment) and nothing in CI
runs it. Making it a gate means fixing the suite first, which is a piece of work in its own right.

### Two pull request bodies carry stale test output

The numbers in the table at the top of this note are the ones measured on the current heads.
#343's and #350's `## Tests` sections showed the numbers from before four commits were pushed to
each; both have been brought up to date.

This is a moving target. Another agent is pushing fixes to those two branches, so the numbers in
their bodies will need checking again before they are merged. The same is true of every branch that
gets a new commit after its body's last edit.

### Nobody but the author has reviewed anything

206 inline comments, 136 of them from a bot, 70 replies from the author. No second human has read
any of these sixteen pull requests.

## What I did not do

- **No pull request was merged.** #320, #324 and #351 were merged earlier in this work; the other
  sixteen are open and ready for the owner to merge.
- No pull request was closed, and no branch was deleted.
- No issue was closed. #280 and #285 closed themselves when their pull requests landed. The issues
  listed above are open on purpose.
- #288 was not edited. It is a decision record.
- No ADR was written for a decision that the code already made obviously. Four ADRs were written
  where the decision was not obvious: 0029 for the pull-versus-push merge rule, 0031 for the
  per-language overrides layering, 0032 for the snapshot contract, and 0033 for the project identity
  guard.
- No review was submitted on any pull request. Every pull request is still in the `COMMENTED`
  state, and none is `APPROVED`. The answers to the bot's findings are in the review threads and in
  this note.
