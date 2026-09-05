# Research: Blocks + code — callouts, tasks, math, mermaid, frontmatter, tables (#132)

Parent map: #129. Live CodeMirror source editing only; no Reading preview pane,
no full transclusion. No code on master; findings live on throwaway branch
`research/blocks-code-132`.

## Sources (primary)

- Domain: `CONTEXT.md` — Document (content + Origin + state), Origin
  (scheme/path/name), Language, Language Mode (auto-detected from Origin
  extension, overridable), Editor Extension (modular piece, e.g. checkbox
  toggling), Storage Coordinator/Provider, Workspace, Preferences.
- ADRs: `docs/adr/0002-monorepo-architecture.md` (headless `@np/core`, zero
  DOM/Node globals; adapters injected into Workspace; `<AppShell>` shares UI);
  `0003-keybinding-system.md` (commands flow through KeymapRegistry, relevant
  for task-toggle command); `0001`, `0004` read, no conflicts.
- Current code (all paths `packages/ui/src/editor/`):
  - `extensions/blockquote.ts` — `Blockquote` node → per-line
    `Decoration.line({class:"cm-blockquote"})`, viewport-scoped
    `syntaxTree.iterate`.
  - `extensions/codeblocks.ts` — `FencedCode` node → per-line
    `cm-fencedCode(-top/-line/-bottom)` + `CopyButtonWidget` at first-line end.
  - `extensions/hide-markers.ts` — fence collapse: first line
    `Decoration.replace` with `LanguageLabelWidget(lang)` from `CodeInfo`,
    last `CodeMark` line `Decoration.replace({})`; `QuoteMark` hide (with
    trailing space); focus/cursor reveal pattern
    (`view.hasFocus && line === curLine`); `ListMark` → bullet/number styling.
  - `extensions/hr.ts` — `HorizontalRule` node → `Decoration.replace` with
    `HorizontalRuleWidget(view,from,to)` when line not active, muted line class
    when active; click selects source range. Template for focus-reveal widgets.
  - `extensions/highlight.ts` — `HighlightStyle` on lezer tags
    (`quote`, `monospace`, `processingInstruction/meta/punctuation/separator`
    as `md-marker`, code tags → `var(--code-*)`).
  - `index.ts:87-102` — single Markdown `LanguageSupport` is the sole language:
    `markdown({codeLanguages: allLanguages, extensions: [Table, GFM,
    WikiLinkExtension]})`; `markdownTables({theme, style, markdownConfig})`
    with Tailwind-token theme (`var(--background/--muted/--border/--primary…)`,
    no magic numbers); `Alt-Mod-t` inserts 2×2 table. Single-language invariant
    proven by `markdown-language.test.ts` (stacking a plain Markdown language
    ahead shadows `[[..]]` as inner `Link` instead of `WikiLink`).
  - `extensions/lists.ts` — `renumberLists` + `smartIndent` (2-space unit),
    no checkbox logic.
  - `extensions/wikilinks.ts` — `MarkdownConfig` precedent (`defineNodes` +
    `parseInline` + `styleTags`); facet pattern (`workspaceFacet`,
    `currentDocFacet`) for completion without Storage I/O.
  - `widgets/{CopyButtonWidget,LanguageLabelWidget,HorizontalRuleWidget,BulletWidget}.ts`;
    `styles/markdown.css` (`cm-blockquote`, `cm-fencedCode*`, `cm-hr-*`,
    `cm-language-label`); `styles/tables.css` exists.
  - `packages/core/src/links.ts:126-137` — frontmatter skip precedent:
    `getHeadings` skips leading `---…---`/`...` block so Setext/H2 and heading
    extraction never misread Properties keys. `getBlocks` is code-fence aware.
  - `packages/core/src/editor/language.svelte.ts:20` — `allLanguages =
    [...languages, ...extraLanguages(svelte)]` feeds `codeLanguages`.
- Deps (verified 2026-09-05): `packages/ui/package.json` has
  `@codemirror/lang-markdown ^6.5.2`, `@lezer/markdown ^1.3.0` (resolved
  1.7.2), `codemirror-markdown-tables ^1.0.0`, `marked`, **no**
  `katex`/`mathjax`/`mermaid`/`remark`/`markdown-it`. Root `package.json` has
  none either. `grep -ri katex|mathjax|mermaid` hits only unrelated
  `node_modules` type maps and `.opencode/effect` docs. Cost below is therefore
  additive, not already-paid.
- Parser primary source: `node_modules/.bun/@lezer+markdown@1.7.2/…/src/extension.ts`
  — `export const GFM = [Table, TaskList, Strikethrough, Autolink]`;
  `TaskList` defines `Task` (block) + `TaskMarker` (`t.atom`), matches
  `/^\[[ xX]\][ \t]/` only when parent is `ListItem`; `Table` defines
  `Table/TableHeader/TableRow/TableCell/TableDelimiter`, no alignment node
  (alignment lives in delimiter text `:---:`). **No `Frontmatter` export**
  exists in `@lezer/markdown@1.7.2`; `@codemirror/lang-markdown@6.5.2` exports
  only `{commonmarkLanguage, markdown, markdownLanguage, …}` — no
  frontmatter/math/mermaid options. Anything in those areas is custom work.
- Obsidian reference (local vault
  `Obsidian-Markdown-Formatting-Examples.md`): Blockquotes & Callouts
  (L217-301), Code (L304-354), Tables (L357-373), Math (L377-404), Diagrams
  Mermaid (L407-462), Tags & Properties frontmatter (L479-514), Lists & Tasks
  (L99-136), Other/HR (L578-584). Help links L671-676 (Format your notes,
  Callouts). All type/alias/syntax claims below cite reference line ranges.

## Per-block seam (what parses today → what to build)

| # | Form (Obsidian ref) | Parses today? | Seam (Language Mode Extension) |
|---|---|---|---|
| 1 | Blockquote `> …` (ref L219-227) | Yes: `Blockquote` + `QuoteMark` | Keep `blockquote.ts` + `QuoteMark` hide. Base layer callouts build on. |
| 2 | Callout `> [!type]` 13 types + aliases, case-insensitive (ref L238) | No node. Renders as plain `Blockquote` | New `CalloutExtension: MarkdownConfig` (`defineNodes: Callout, CalloutMark, CalloutTitle` + `parseBlock`, `styleTags`) following `wikilinks.ts` precedent, **plus** one `ViewPlugin` for type color/icon/fold/nest. Single-language rule: append to the existing `extensions: [Table, GFM, WikiLinkExtension, CalloutExtension]` array in `index.ts:89,101`, never a second `markdown()`. |
| 3 | Callout custom title `> [!tip] Make it your own` (ref L281-282) | No | Same `CalloutExtension`: title = remainder of first line after `]`. Decorate title bold-ish; keep source editable (no replace). |
| 4 | Foldable `> [!note]-` collapsed / `+` expanded (ref L288-292) | No | Same `ViewPlugin`: parse trailing `+`/`-` on marker line; collapsed = fold range over body lines (reuse `foldGutter()` already in `index.ts`) or a disclosure `WidgetType` (HR-widget pattern); click/Enter toggles fold, never deletes source. Default-open unless `-`. |
| 5 | Nested `> > [!tip]` (ref L296-300) | Partial (nested `Blockquote` parses) | `ViewPlugin` must be depth-aware: iterate `Blockquote` ancestry, apply `cm-callout-nest-N` + per-type accent via `var(--callout-<type>)` tokens. Parser: allow `Callout` inside `Blockquote` (composite contexts already nest). |
| 6 | Task `- [ ]` / `- [x]` / `- [X]`, nested (ref L128-136) | **Yes**: `Task` + `TaskMarker` via GFM (already in `extensions` through `GFM`; `Table` listed twice is harmless dup) | New task `Extension` (CONTEXT term): `ViewPlugin` replaces `TaskMarker` range with a real `<input type=checkbox>` widget (HR-widget click pattern) + `decideTaskToggle`-style pure helper + toggle `StateCommand`/keymap entry (ADR-0003 pipeline). No new parser. See model below. |
| 7 | Fenced ` ```lang ` + highlight (ref L316-347; 4-backtick rule L314) | Yes: `FencedCode` + `CodeInfo` + `CodeMark`, `codeLanguages: allLanguages` | Keep `codeblocks.ts` + `hide-markers.ts` fence collapse. Gaps only: `mermaid`/`math` info strings have no `codeLanguages` entry → plain mono (intended until plugins); add golden tests for ` ```python/javascript/json/bash/css ` + 4-backtick fence. `LanguageLabelWidget` is currently wired in `hide-markers.ts`, not `codeblocks.ts` — keep one owner (hide-markers). |
| 8 | Indented code, 4-space/tab (ref L349-353) | Parses as `IndentedCode`, unstyled | Trivial: extend `markdownHighlight` (`t.monospace`-adjacent) + one line-decoration class in `codeblocks.ts` (or CSS-only). No widget. Golden-test that inner Markdown is not parsed. |
| 9 | GFM tables + `:---` / `:---:` / `---:` (ref L359-371; inline fmt L373) | Yes: `Table*` nodes + `markdownTables()` theme/autocomplete/`Alt-Mod-t` | Keep. No new seam. Golden-test alignment delimiters + bold/code/link-in-cell. Do not reimplement editing (the lib owns cell nav/selection). |
| 10 | YAML frontmatter `---` top block → Properties (ref L491-514) | No node; `---` would misparse as `HorizontalRule`/Setext | New `FrontmatterExtension: MarkdownConfig` leaf-block (same shape as `TableParser` in lezer `extension.ts`): only when `doc` starts at pos 0 with `---\n`, close at `---`/`...`; node `Frontmatter`/`FrontmatterMark`. Style muted + `md-faded` delimiter; optional `yaml` code language for keys. Extend `core/links.ts` skip (already for headings) to tags/blocks/word-count. See Properties-vs-Document rule below. |
| 11 | Math inline `$…$`, block `$$` own lines (ref L379-397; MathJax L379) | No (parsed as plain text/`InlineCode`-adjacent) | **Highlight-only now** (delimiters + content class, no render). Full render gated as core plugin (see table). |
| 12 | Mermaid ` ```mermaid ` flowchart/sequence/gantt/class/pie (ref L409-462) | Parses as `FencedCode` lang=`mermaid`, no renderer | **Fenced-code treatment now** (label + copy button). Live diagram gated as core plugin (see table). |
| 13 | HR `---` / `***` / `___` (ref L581-584) | Yes: `HorizontalRule` → replace widget + active-line reveal | Keep `hr.ts` as-is; it is the focus-reveal template for future math/mermaid widgets. Note `---` ambiguity with frontmatter open/close and Setext H2 — frontmatter leaf must win at pos 0. |

### Callout detail (13 types + aliases)

Reference L238 + L240-277. Case-insensitive (`> [!NOTE]` == `> [!note]`).
Canonical → aliases:

- `note` (–); `abstract` → `summary, tldr`; `info` (–); `todo` (–);
  `tip` → `hint, important`; `success` → `check, done`;
  `question` → `help, faq`; `warning` → `caution, attention`;
  `failure` → `fail, missing`; `danger` → `error`; `bug` (–);
  `example` (–); `quote` → `cite`.

Unknown `[!foo]` must degrade to plain `Blockquote` (never error, never drop
content). Title, fold marker, and type token stay in source; collapsed
rendering hides body lines via folding, not deletion. Colors/icons resolve
through existing token pipeline (`var(--primary/--muted/--border…)` +
per-type `var(--callout-<type>)` added to theme, no magic numbers — map
convention). Icons should reuse the Icon Registry seam (cf. map #121 themed
icons), not inline SVG per type.

### Callout fold/nest approach (recommended)

1. Parse: `CalloutExtension` detects `QuoteMark`-leading line matching
   `/^\[![\w-]+\][+-]?( |$)/i` inside a `Blockquote`. Emits
   `Callout(CalloutMark, CalloutTitle?)` wrapping the blockquote content so
   the syntax tree asserts in golden files (`nodeKinds` pattern from
   `markdown-language.test.ts:18-27`).
2. Style: `ViewPlugin` (same file, same viewport-iterate shape as
   `blockquote.ts:20-47`) adds `cm-callout cm-callout-<type>` line classes +
   a gutter disclosure widget (`WidgetType`, `eq` on `{type, folded}` like
   `CopyButtonWidget:eq`). `+` = expanded-but-collapsible, `-` = collapsed by
   default, absent = plain expanded callout (ref L286-292).
3. Nest: `> > [!tip]` yields nested `Blockquote`; plugin walks
   `node.node.parent` chain (as `hide-markers.ts` does for `Link`/`URL`) and
   emits depth class; CSS indents/borders per depth. No parser recursion
   beyond what composite blocks already do.
4. Interaction: click disclosure (or fold gutter) folds body range; cursor
   inside marker line reveals source (`hasFocus && line === curLine` pattern
   from `hide-markers.ts:63` / `hr.ts:38-39`). No contenteditable title —
   title edits happen in source text.

### Task Extension interaction model (recommended)

- Nodes already exist (`Task` block, `TaskMarker` atom via GFM). Build a
  single task `Extension` in `extensions/tasks.ts` exporting
  `taskPlugin: ViewPlugin` + `toggleTask: StateCommand`, wired in
  `index.ts` alongside `blockquotePlugin/codeBlockPlugin/horizontalRulePlugin`:
  1. Decoration: `syntaxTree.iterate` → on `Task`/`TaskMarker`, `Decoration.replace`
     (or `Decoration.widget` at marker) with a native checkbox
     (`<input type="checkbox" class="cm-task-checkbox">`, `checked` iff
     `/\[[xX]\]/`). `eq` on checked-state so updates are cheap. Follows
     `HorizontalRuleWidget` click-to-select-source pattern, but toggle writes.
  2. Toggle writes source: `view.dispatch({changes:{from: markerFrom+1, to:
     markerFrom+2, insert: checked ? " " : "x"}})` — preserves `-`, indent,
     and trailing space; `[X]` normalizes to `[x]` on first toggle (document
     in golden test). Cursor stays on line; undo is native history.
  3. Hit area: click on widget toggles; `Alt/Option+click` on line also toggles
     (mirrors Obsidian); keyboard: command `toggle-task` bound via ADR-0003
     keymap (suggest `Mod-Enter` when selection inside a `Task` line) calling
     the same `StateCommand`. `smartIndent`/`renumberLists` in `lists.ts` must
     ignore `TaskMarker` ranges (only renumber `/^(\s*)(\d+)\.\s/` lines —
     already safe — and indent moves whole `getListBlockRange`, which already
     carries subtasks).
  4. States: `- [ ]`, `- [x]`, `- [X]` all parse (lezer regex includes `X`);
     any other bracket char (`- [/]`) is plain `ListItem`, not `Task` — keep
     that GFM fidelity, do not extend.
  5. Tests: golden parse-tree (`Task`/`TaskMarker` present, nested tasks),
     decoration test (checkbox `checked` mirrors source), toggle round-trip
     (`[ ]→[x]→[ ]`, `[X]→[ ]`), focus-reveal (cursor in marker shows source
     marks per hide-markers convention).

### Frontmatter handling (Properties vs Document vs Origin)

- Obsidian rule (ref L491-514): frontmatter is the `---…---` block at the
  **very top** of the file only; rendered as Properties (typed: text, list,
  number, checkbox, date, date&time, boolean; keys like `title/tags/aliases/
  created/cssclasses/published/rating/amount/due` in the example). It is
  metadata **about** the Document, not identity.
- Project mapping (CONTEXT.md): `Origin` = where persisted
  (scheme/path/name) and drives Language Mode detection; `Document` =
  content + Origin + state; Properties = derived view over the leading YAML
  block. Therefore: **never store frontmatter as Origin, never strip it on
  save** (Storage Coordinator/Provider round-trips raw Document text).
  `getHeadings` skip (links.ts:126-137) is the correct precedent — extend the
  same skip to tag extraction, block extraction, word counts, and outline.
- Phase 1 (this map): parse + dim. `FrontmatterExtension` leaf node,
  `Decoration.line` muted + delimiter `md-faded`, YAML keys highlighted if a
  yaml language is available, `---`/`...` close both accepted. No Properties
  panel, no schema validation, no `cssclasses` application in this effort
  (panel is a post-map Extension reading the parsed node). `---` at pos 0
  wins over `HorizontalRule`/Setext; `---` elsewhere keeps current HR/Setext
  behavior. Unclosed leading `---` = plain content (no node), matching
  Obsidian's "must close" behavior.

## Now vs plugin-gated (math + mermaid line)

User stance (ticket): math + mermaid ship later as core plugins once the
plugin API exists. Recommendation below holds that line and makes
highlight-only vs widget explicit.

| Area | Ship in this map (core now) | Gate as core plugin (needs plugin API) | Why the line is here |
|---|---|---|---|
| Callouts (all 13 + aliases/title/fold/nest) | Yes — parser + decorations + fold, no deps | — | Pure CodeMirror seams, no new deps, no async. |
| Tasks checkbox | Yes — widget + toggle command, no deps | — | Same sync `ViewPlugin` + `StateCommand` shape as HR/lists. |
| Fenced + indented code | Yes — keep + style `IndentedCode`, golden tests | — | `codeLanguages` already paid; no deps. |
| Tables + alignment | Yes — keep lib, golden tests | — | Lib already integrated + themed. |
| Frontmatter Properties (parse + dim + skips) | Yes | Properties panel/schema later (not this map) | Parse is sync; panel is new surface. |
| HR | Yes — keep | — | Done. |
| Math `$`/`$$` | **Highlight-only**: delimiter `md-marker` + content class via `HighlightStyle`/mark decorations; cursor-reveal; golden tests for inline vs block vs `$` in code Dank | Live render (KaTeX/MathJax widget, async typeset, per-line dispose, error badge, SSR-safe) | Render adds a heavy dep (MathJax ≈ Obsidian parity but large; KaTeX smaller but subset — decision deferred to plugin ticket), async layout + dispose + theme + a11y; needs plugin lifecycle (enable/disable, version pin, CSP). Highlight has none of that. |
| Mermaid ` ```mermaid ` | **Fenced-code only**: language label + copy + mono, no preview | Live diagram (mermaid lib, async `mermaid.render`, zoom/pan, error surface, sandbox for `<script>`-stripping parity, theme sync) | Same lifecycle reasons + larger bundle + security surface (HTML passthrough rule: `<script>` stripped, Markdown-in-HTML not parsed — ref L611-615). Preview must not run until the plugin API can sandbox, dispose, and gate per-Document. |

Gating conditions (both math + mermaid): plugin API supports (a) async
`WidgetType` with dispose on doc/viewport change, (b) per-Language-Mode
enable/disable + dep version pin, (c) error-boundary rendering (bad syntax →
source-reveal + badge, never blank), (d) light/dark token sync, (e) no
`Storage` reads for render (content comes from the `Document` text only).
Until then, any `$`/`mermaid` work that touches `package.json` deps is out of
scope — highlight-only is the ceiling.

## Harness note (for map #129 consumers)

- Golden files feed the 16-category reference through `nodeKinds`-style
  parse-tree assertions (`markdown-language.test.ts:18-27`) + decoration
  spot-checks. New nodes to assert: `Callout/CalloutMark/CalloutTitle`,
  `Task/TaskMarker` (already assertable today — write the test first to lock
  GFM wiring), `Frontmatter/FrontmatterMark`, `Table*` alignment delimiters,
  `FencedCode/CodeInfo/CodeMark`, `IndentedCode`, `HorizontalRule`,
  `Blockquote/QuoteMark`. Math/mermaid golden tests assert highlight-only
  (delimiters marked, no widget) so a future plugin PR must flip them
  deliberately.

## Gist

Single Markdown `LanguageSupport` stays the seam; tasks already parse via GFM
and need only a checkbox `Extension` (widget + toggle command); callouts and
frontmatter need small custom `MarkdownConfig`s with viewport `ViewPlugin`
styling (fold/nest and dim respectively); tables/HR/fenced code are done;
math and mermaid stay highlight-/fence-only until the plugin API can host
their async renderers — that is the gating line.
