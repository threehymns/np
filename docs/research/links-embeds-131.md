# Research: Links, embeds, media (#131)

Parent map: #129. Phase 1 = link-like only (style + hide-markers + click/hover,
no full transclusion). Live source editing only; no Reading preview pane.

## Sources

- Domain: `CONTEXT.md` (Document, Origin, Language Mode, Editor Extension,
  Storage Coordinator/Provider, Workspace); `docs/adr/0002-monorepo-architecture.md`
  (headless `@np/core`, platform adapters injected into `Workspace`).
- Current code: `packages/ui/src/editor/extensions/wikilinks.ts`
  (WikiLinkExtension parseInline, alias/target nodes, autocomplete via
  `workspaceFacet`/`currentDocFacet`); `packages/ui/src/editor/extensions/hide-markers.ts`
  WikiLink branch (embed-aware open-mark length); `packages/ui/src/editor/extensions/link-events.ts`
  + `link-events.test.ts` (pure `decideLinkClick`/`decideLinkMousedown`, Enter/click
  via `openInternalLink`, `window.open` for http(s)/mailto); `packages/ui/src/editor/extensions/wikilinks.test.ts`;
  `packages/core/src/links.ts` + `links.test.ts` (`parseInternalLink`,
  `getHeadings`/`getBlocks`, `findHeadingLine`/`findBlockLine`,
  `resolveTargetOrigin`, `openInternalLink`, `searchVaultForFile`).
- Obsidian reference (local vault doc): sections Links (Internal & External),
  Embeds / Transclusion, Media & Files, Other (Autolinks).

## Per-form coverage and phase-1 seam

| # | Form (Obsidian ref) | Current coverage | Phase-1 seam (link-like only) |
|---|---|---|---|
| 1 | `[text](https://url)` external | Covered: lezer `Link` node; hide-markers hides `LinkMark`+`URL` when collapsed, `cm-link-expanded` when cursor inside; `decideLinkClick` returns `{kind:link, raw:url}`, click `window.open` for `^(https?:\|mailto:)`. Proven by `link-events.test.ts` "standard link at end of line". | Keep. No Core/Workspace read. |
| 2 | `[text](url "title")` hover title | Partial: lezer parses `LinkTitle`; hide-markers hides `URL` but has no explicit `LinkTitle` branch (falls into generic marker hide only if name matches Mark/Delimiter). | Keep `Link` seam; extend hide-markers to treat `LinkTitle` like `URL` (hide when collapsed, show when expanded); hover = native `title`/CSS only. No Storage read. |
| 3 | Bare `https://obsidian.md`, `www.example.com` (GFM autolink) | Styled by lezer GFM (`URL`/Autolink highlight). Deliberately inert: `link-events.test.ts` "bare external URL … never claims". `hide-markers.ts` leaves standalone `URL` visible (`shouldShow=true` when no parent `Link`). | Keep style as-is. Add click-only seam in phase 1: extend `decideLinkClick` to return external URL for bare `URL` nodes (normalize `www.` → `https://`), `window.open`, no Workspace. No hover preview. Small, no Storage read. |
| 4 | `[[N]]`, `[[N.md]]`, `[[Folder/N]]` | Covered end-to-end: `WikiLinkExtension` parseInline (`[[`/`]]` → `WikiLink`+`WikiLinkTarget`+`WikiLinkMark`); `styleTags` → `t.link`; hide-markers hides `[[`/`]]` when collapsed; click/Enter → `openInternalLink` → `resolveTargetOrigin` (root-relative → current-dir-relative → vault-wide `searchVaultForFile` → create). Autocomplete lists tree files + open docs. Proven by `wikilinks.test.ts` + `links.test.ts` (root/subfolder/explicit-path/create cases). | Keep all three seams unchanged. |
| 5 | `[[N\|alias]]` | Covered: parser splits on first `\|` into `WikiLinkTarget`/`WikiLinkAlias`; hide-markers collapses to alias only (`node.from..alias.from` + `]]` replaced); click passes full raw to `parseInternalLink` (alias stripped before resolve). Proven by `wikilinks.test.ts` "hides [[Target\| and ]]". | Keep. Resize disambiguation below is the only change. |
| 6 | `[[N#H]]`, `[[N#H1#H2]]` nested, `[[#H]]` same-note | Covered: parser keeps `#…` inside `WikiLinkTarget`; `parseInternalLink` splits on first `#` (heading path preserves inner `#`); `openInternalLink` sets `pendingLineToScroll` via `findHeadingLine` (case-insensitive, nested path). Empty path → current/active doc. Autocomplete `[[#`/`[[N#` via `getHeadings(current or workspace doc)`. Proven by `links.test.ts` heading cases + `wikilinks.test.ts` heading completion. | Keep. No new seam. |
| 7 | `[[N#^id]]`, `[[#^id]]`, `[[^id]]` block refs | Covered: `parseInternalLink` block regex `/(?:^\|#)\^([a-zA-Z0-9-]+)$/` with trailing-`#` strip; `findBlockLine` (`^id` line-end, code-fence aware); same empty-path rule; autocomplete `[[#^`/`[[^`/`[[N#^` via `getBlocks`. Proven by `links.test.ts` block cases + completion test. | Keep. No new seam. |
| 8 | `[text](Note.md#heading)` markdown internal | Covered: lezer `Link`; non-http `URL` verdict → `openInternalLink(workspace, doc, url)`; `parseInternalLink` handles raw destinations + `%20` decode. | Keep. No new seam. Consider test for `%20` + `#heading` markdown path (already unit-covered at parse level). |
| 9 | `![[Note]]`, `![[Note#H]]`, `![[Note#^id]]` note embeds | Parsed (leading `!` → same `WikiLink` node, 3-char open mark; hide-markers already `!`-aware). `parseInternalLink` sets `isEmbed`; `resolveTargetOrigin` called with `{allowCreate:false}` so missing embeds never create files. Click/Enter navigates + scrolls like a link. | Phase 1 = treat exactly like link + embed-distinct style (e.g. `cm-embed` class alongside `cm-link`) and same hide-markers collapse. No content fetch. Autocomplete already `!?` aware. |
| 10 | `![[image.png]]`, `![[image.png\|300]]` wikilink media + resize | Parsed as `WikiLink`; `\|300` currently lands in `WikiLinkAlias` (no size/target split). `parseInternalLink` returns `alias:"300"`. `wikilinks.test.ts` proves `![[Figure 1.png]]` target parse; no size test. | Phase-1 change (parse + decoration only): add pure `parseSizeToken` in `@np/core/links.ts` (`/^\d+(x\d+)?$/`, bare width `300` and optional `WxH`); UI reuses it in hide-markers/decoration layer to (a) keep hide behavior (hide `![[…\|` + `]]`, show alias-or-nothing), (b) render a size badge / width style. No binary fetch, no player. Click → `resolveTargetOrigin(allowCreate:false)` + `openFile` attempt only (no-op if binary unsupported). |
| 11 | `![Alt](image.png)`, `![alt\|400](photo.png)` markdown image + resize | Lezer `Image` node (not `Link`); hide-markers `inlineTypes` includes `Image` so marks hide generically; `\|400` sits inside the label text with no size split; no size test. | Phase-1 change (decoration only): same `parseSizeToken` applied to label suffix (`alt\|400` → alt + size) in hide-markers/widget layer; render size badge. No new parser node. Click seam: extend `decideLinkClick`/`findLinkNode` to include `Image` (currently `Link`/`WikiLink` only) returning the destination; external → `window.open`, vault-relative → `resolveTargetOrigin(allowCreate:false)`. No binary fetch. |
| 12 | `![[audio.mp3]]`, `![[video.mp4]]`, `![[document.pdf]]` | Same parse/resolve path as #10 (`isEmbed`, no-create). No player/viewer code exists. | Phase 1 = same as #10: link-like style (media-distinct class optional), hide-markers collapse, click attempts resolve+open only. No `<audio>`/`<video>`/PDF viewer, no blob/Storage content read for render. |
| 13 | `![Alt](https://… "title")` remote image | Lezer `Image` with `URL`+`LinkTitle`; same generic hide as #11. | Keep; same `LinkTitle`-hide fix as #2. Click → `window.open`. No download/cache. |

Notes on existing autocomplete seam: `wikilinkAutocompletion` suppresses
completion after any `\|` (correct for both alias and `\|300` resize — no
change needed); heading/block completion reads only in-memory
`workspace.documents` content + `projectTree` file list + `currentDoc.content`
— no `Storage` I/O, which is the right pattern for phase 1 (see below).

## Where Workspace / Storage Coordinator reads belong in phase 1

- Allowed (already in place, keep): autocomplete reads in-memory `Workspace`
  (`documents`, `projectTree.nodes` via `getAllFilesFromTree`,
  `currentDoc.content`) — no `Storage` I/O. Click/Enter navigation reads via
  `resolveTargetOrigin` → `workspace.storage.readFile` probes (root-relative,
  current-dir-relative) + `searchVaultForFile` (`readDirectory` walk) +
  `workspace.openFile`/`loadContent`. That is navigation, not transclusion,
  and stays.
- Not allowed in phase 1: any `Storage` content read for render — no embed
  body fetch (`![[…]]` note/heading/block content), no image/audio/video/PDF
  blob fetch, no hover-preview fetch, no async existence decoration. Reasons:
  (a) map explicitly scopes transclusion out ("first phase is link-like
  styling + resize/click only"); (b) `hide-markers` recomputes synchronously
  per keystroke/viewport — async I/O there needs a debounced async layer that
  does not exist yet; (c) transclusion needs recursion/scroll/perf design
  (nested embeds, size layout, binary handling) reserved for the transclusion
  slice.
- Consequence: no unresolved-link styling in phase 1 (it would require a
  per-decoration existence check). Style all wikilinks uniformly; creation of
  missing notes happens lazily on click/Enter (existing behavior), missing
  embeds never create (existing `allowCreate:false`).

## Deferred (with reason)

1. Full `![[…]]` transclusion render (note/heading/block inline content via
   Storage Coordinator). Reason: needs async fetch + nested parse + recursion
   guard + scroll/selection mapping; map Out of scope for phase 1.
2. Media renderers (image bitmap, `<audio>`/`<video>` players, PDF viewer,
   `\|300` actual layout width beyond badge). Reason: binary/blob pipeline +
   layout/perf work; phase 1 covers `\|300` parse + badge only.
3. Hover preview popups for links/embeds. Reason: no hover seam exists in
   `link-events.ts` (click/Enter/mousedown only); preview would need the same
   async fetch as (1). Phase-1 hover = CSS/title only.
4. Unresolved-link distinction (Obsidian's missing-target icon). Reason:
   requires async existence check per decoration; deferred to avoid sync
   decoration doing I/O.
5. Markdown `![alt\|400](…)` actual scaled render + `WxH` forms. Reason: same
   as (2); parse + badge is phase 1, layout is later.
6. `www.example.com` without scheme and bare-URL Cmd/Ctrl-click modifier
   policy. Reason: trivial but needs UX decision (Obsidian uses Cmd+click in
   source); park until link-click modifier is specced.

## Evidence

- `bun test packages/core/src/links.test.ts` covers parse (all `[[…]]` forms,
  embed flag, alias, `%20`), heading/block find, and `openInternalLink`
  navigation/scroll/create rules.
- `bun test packages/ui/src/editor/extensions/wikilinks.test.ts` covers
  `WikiLink` AST (marks/target/alias), `![[…]]` parse, hide-markers
  collapse/expand, and `[[`/`[[#`/`[[#^` completion.
- `bun test packages/ui/src/editor/extensions/link-events.test.ts` covers
  collapsed-link click vs trailing-space snap, external `Link` verdict, and
  bare-`URL` inertness.
- Gaps (no test yet, expected): `\|300` size split, `Image`-node click
  verdict, `LinkTitle` hide, `www.` normalization — these are the phase-1
  implementation slice, not this research.
