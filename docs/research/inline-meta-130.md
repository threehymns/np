# Research: Inline formatting + meta (#130)

Parent map: #129. Slice order Inline → links → blocks; this file covers the
inline slice only (live CodeMirror source editing, no Reading preview).
Obsidian-first: `==highlight==`, `%%hidden%%`, `#tag/sub` win over portable
CommonMark where they conflict.

## Stack versions (evidence)

- `packages/ui/package.json`: `@lezer/markdown ^1.3.0`,
  `@codemirror/lang-markdown ^6.5.2`, `@lezer/highlight ^1.2.3`,
  `@codemirror/view ^6.43.8`, `@codemirror/language ^6.12.3`.
- Resolved in `bun.lock`: `@lezer/markdown@1.7.2`,
  `@codemirror/lang-markdown@6.5.2`.
- `packages/ui/src/editor/index.ts`: `markdown({ codeLanguages,
  extensions: [Table, GFM, WikiLinkExtension] })` is the sole Markdown
  language (plain `lang` deliberately excluded so `[[..]]` parses as
  `WikiLink`, see inline comment); `Table`/`GFM` also passed to
  `codemirror-markdown-tables` `markdownConfig`.
- Precedent custom extension: `extensions/wikilinks.ts` (`MarkdownConfig`
  with `defineNodes` + `parseInline` `{name:"WikiLink", before:"Link"}`,
  `styleTags` → `t.link`).
- Seams: `extensions/hide-markers.ts` (`ViewPlugin.fromClass`, `syntaxTree`
  iterate over `visibleRanges`, `Decoration.replace/mark`, `BulletWidget`,
  `LanguageLabelWidget`); `extensions/highlight.ts`
  (`HighlightStyle.define`); `extensions/lists.ts` (regex renumber only for
  `^(\s*)(\d+)\.\s`, smart-indent `^(\s*)([*+-]|\d+\.)\s`).

## What `@lezer/markdown@1.7.2` actually exports (evidence)

Source: `node_modules/.bun/@lezer+markdown@1.7.2/.../dist/index.js` +
`dist/index.d.ts` (primary: library source + types).

- Exports: `parser, GFM, Table, TaskList, Strikethrough, Autolink,
  Subscript, Superscript, Emoji, MarkdownParser, parseCode`
  (+ `BlockContext, InlineContext, Element, Line, LeafBlock`). Verified by
  dynamic import key listing.
- `GFM = [Table, TaskList, Strikethrough, Autolink]` (source line ~2275).
- **No** `Footnote`, **no** `Highlight`/`Mark`, **no** `Tag`, **no**
  percent-comment, **no** block-ref export. Full `.d.ts` export list
  confirms absence.
- Default inline parsers (`.d.ts` `InlineParser.before` docs): `Escape,
  Entity, InlineCode, HTMLTag, Emphasis, HardBreak, Link, Image`.
- Base node types (source `Type` enum + `DefaultInline`): `Emphasis`,
  `StrongEmphasis`, `EmphasisMark`, `InlineCode`, `CodeMark`, `Escape`,
  `HardBreak`, `Link`, `LinkMark`, `Image`, `URL`, `HeaderMark`,
  `ListMark`, `QuoteMark`, `ATXHeading1-6`, `SetextHeading1/2`,
  `OrderedList/BulletList`, `Comment/CommentBlock` (HTML `<!-- -->` only),
  `HTMLBlock/HTMLTag`, `HorizontalRule`, `Entity`.
- `markdownHighlighting = styleTags({...})`: `Emphasis→emphasis`,
  `StrongEmphasis→strong`, `Escape→escape`, `InlineCode/CodeText→monospace`,
  `URL/Autolink→url`, `Comment/CommentBlock→comment`,
  `HeaderMark/HardBreak/QuoteMark/ListMark/LinkMark/EmphasisMark/CodeMark
  →processingInstruction`, headings `ATX/Setext 1-2→heading1-2`,
  `3-6→heading3-6`.
- `@codemirror/lang-markdown@6.5.2` `.d.ts`: `markdown({ extensions?:
  MarkdownExtension })` — custom `MarkdownConfig` objects plug in exactly
  like `WikiLinkExtension`.
- `@lezer/highlight@1.2.3` `tags` keys include `strikethrough`, `tagName`,
  `meta`, `comment`, `labelName`, `link`, `emphasis`, `strong`,
  `processingInstruction` — **no** `mark`/`highlight`/`tag`/`footnote` tag.
  So `==highlight==` needs an existing tag + CSS class; `#tag` can use
  `tagName`.

## Obsidian ground truth used (evidence)

- `docs`: local vault `Obsidian-Markdown-Formatting-Examples.md` sections
  Basics, Headings, Lists, Tags & Properties (inline part), Footnotes,
  Comments, Block References, Other — the ticket-assigned reference.
- First-party: `https://obsidian.md/help/obsidian-flavored-markdown`
  extension table (`==Text==` Highlights, `%%Text%%` Comments, `[^id]`
  Footnotes, `^id` Defining a block, `~~Text~~` Strikethroughs,
  `[[Link]]`/`![[Link]]` links+embeds, `> [!note]` callouts);
  `https://obsidian.md/help/syntax` (paragraphs, breaks, headings, bold /
  italics / highlights, footnotes, comments, escapes); `https://obsidian.md/help/tags`
  (nested tags via `/`; body `#tag` or frontmatter `tags:`).
- Tag charset corroborated by reference + help: letters, numbers, `_`, `-`,
  `/`; never numbers-only; `#` directly followed by text (no space); nest
  with `/` (`#project/active`).

## Per-feature parse-vs-gap table

| # | Form (Obsidian ref) | Parse today (lezer 1.7.2 + our config) | Gap | Recommended seam |
|---|---|---|---|---|
| 1 | `**bold**`, `__bold__`, `*italic*`, `_italic_`, `***both***` | Covered: base `Emphasis` inline parser → `Emphasis`/`StrongEmphasis` + `EmphasisMark`; style `emphasis`/`strong`; hide-markers surgically hides marks when cursor outside parent (`inlineTypes` incl. `Emphasis`, `StrongEmphasis`) | None for parse/style/hide | Keep |
| 2 | `~~struck~~` | Parsed: `GFM` includes `Strikethrough` (enabled) → `Strikethrough` + `StrikethroughMark` | Style/hide gap only: `highlight.ts` has no `t.strikethrough` rule; `hide-markers.ts` `inlineTypes` lacks `Strikethrough` so marks hide only via generic `Delimiter` path without parent-intersection logic | Keep parser; add `HighlightStyle` `t.strikethrough` (line-through) + add `Strikethrough` to `inlineTypes` parent list |
| 3 | `==highlight==` | **Not parsed**: no Highlight export in 1.7.2; text stays plain paragraph content | Full gap: node + style + hide | New `MarkdownConfig` `parseInline` delimiter pair (model on `Strikethrough` source + our `WikiLinkExtension` shape): `defineNodes Highlight, HighlightMark`, `DelimiterType{resolve:"Highlight", mark:"HighlightMark"}` on `=`/`=`; `styleTags Highlight→t.content` (no dedicated tag exists) + `HighlightStyle` class `cm-highlight` (`<mark>`-like bg); hide-markers: replace `HighlightMark` when collapsed |
| 4 | `# H1`…`###### H6` (ATX, space required) | Covered: `ATXHeading1-6` + `HeaderMark`; `heading1-6` styles; hide-markers replaces `HeaderMark` (+1 trailing space) when line unfocused | None | Keep |
| 5 | Setext `Title\n===` / `---` | Covered: `SetextHeading1/2` + `HeaderMark` underline; hide-markers fades (`md-faded`) rather than replaces | Note ambiguity: `---` is also HR / frontmatter fence — block-layer concern, not inline | Keep |
| 6 | `-`/`*`/`+` bullets, `1.`/`1)` ordered, nested by indent, `- [ ]`/`- [x]` tasks | Covered: `BulletList/OrderedList` + `ListMark`, `Task/TaskMarker` via `GFM→TaskList` (enabled); hide-markers `BulletWidget` / `md-list-number`; `lists.ts` renumber + smart-indent | Small functional gap: `renumberLists` regex `^(\s*)(\d+)\.\s` ignores `1)` style (ref shows `1)` accepted) | Keep parser; optionally extend renumber regex to `(\d+)[.)]` in builder slice (not this ticket) |
| 7 | `` `code` `` inline | Covered: `InlineCode` + `CodeMark`/`CodeText` → `t.monospace`; marks hidden when collapsed | None | Keep |
| 8 | `#tag`, `#tag/sub` inline incl. nested | **Not parsed**: no Tag node in lezer; `#tag` at line start without space is just paragraph text; `# H` with space is a heading | Full gap; disambiguation is the design point (see below) | New `MarkdownConfig` `parseInline`: `defineNodes Tag, TagMark?`, scan `#` where prev is BOF/whitespace/`(`/`[` and next matches tag-start charset; `styleTags Tag→t.tagName`; hide-markers: do NOT hide (tags have no markers to hide; whole token styled) |
| 9 | `[^1]` ref + `[^1]: text` def | **Not parsed**: no Footnote export in 1.7.2 (GFM bundle is tables/tasks/strike/autolink only) | Full gap: ref inline + def block/leaf | New `MarkdownConfig`: `parseInline` for `[^label]` ref (before `Link`, like WikiLink — `[`+`^` prefix avoids clashing with normal links); def needs `parseBlock`/`leaf` or `LinkReference`-adjacent handling (builder slice); style `→t.link` + `sup`-like class; **not** ViewPlugin-only (refs need tree nodes for click/hover later) |
| 10 | `^[inline footnote]` | **Not parsed** (same reason as #9) | Full gap; collides with `^block-id` and Pandoc `Superscript ^..^` (not enabled — keep it that way) | Same Footnote config: `parseInline` on `^`+`[`; order before block-id scan; style same as #9 |
| 11 | `%%hidden%%` | **Not parsed**: base `Comment` is HTML `<!-- -->` only (`CommentEnd=/-->/` source) | Full gap | New `MarkdownConfig` `parseInline` eager `%%…%%` (non-nesting, single-paragraph): `defineNodes HiddenComment, HiddenCommentMark`, `styleTags→t.comment`; live-source decision: style faded (like Setext underline), do NOT `replace`-hide — Obsidian keeps it visible in Source mode |
| 12 | `<!-- hidden -->` HTML comment | Covered: `Comment`/`CommentBlock`, `t.comment` | None (stays visible in source; matches Obsidian "works in both views") | Keep |
| 13 | `^block-id` line-trailing anchor | **Not parsed**: no block-ref node in lezer | Gap: anchor display only (link targeting already works: `getBlocks` + `findBlockLine` + `[[#^]]` autocomplete proven by sibling #131 research) | Either `parseInline` end-of-line `^[\w-]+` node (`BlockRef→t.meta`/`t.labelName` + `md-faded` class) for uniformity with WikiLink precedent, or line-based `ViewPlugin` regex decoration as fallback if parser intrusion proves costly; prefer `parseInline` so HideMarkers fade applies uniformly; must run after footnote-inline check |
| 14 | `\*`, `\#`, `\~~` escapes | Covered: `Escape` node → `t.escape` | None | Keep |
| 15 | Hard break (two trailing spaces) vs soft newline | Covered: `HardBreak` (`→processingInstruction`); single newline stays paragraph (matches ref) | None | Keep |
| 16 | `<http://…>` + bare `https://…` / `www.…` autolinks | Covered: base `Link` for `<>`; `GFM→Autolink` (enabled) for bare → `URL`/`Autolink` → `t.url`; hide-markers leaves standalone `URL` visible, hides inside `Link` when collapsed | None for parse | Keep (click behavior is #131 slice) |
| 17 | HTML passthrough `<div>`, `<br>`, `<u>`, `<sub>/<sup>`; Markdown NOT parsed inside HTML blocks | Covered: `HTMLTag` inline + `HTMLBlock`; Obsidian "does not render Markdown inside HTML" matches lezer behavior | None | Keep; do not enable extra HTML parsing |
| 18 | Emoji 🎉 direct (Obsidian has no `:shortcode:`) | Direct unicode needs nothing; lezer `Emoji` (`:name:`) extension exists but is **not enabled** — correctly so per ref Other section | No action | Do NOT enable `Emoji`; avoids `::` false positives |
| 19 | `~sub~` / `^sup^` Pandoc extensions | Exist in lezer (`Subscript`, `Superscript`) but **not enabled** | Intentional non-use: `~` collides with `~~strike`, `^` collides with `^block-id` / `^[footnote]`; Obsidian-first says block-id + strike win | Do NOT enable; record decision |

## `#tag` vs `#heading` disambiguation (the focus question)

Evidence: lezer block source `ATXHeading` requires `#`s at composite-block
start followed by space/EOL (`HeaderMark` + space-skip); our
`hide-markers.ts` `HeaderMark` branch consumes one trailing space, proving
the space rule in-tree. Tags per Obsidian help + ref are **inline**:
`#` + text with **no** space, valid mid-line.

Recommended rule for the Tag `parseInline` (Obsidian-first):

- Trigger only when `next === 35 /* # */`, previous char is BOF, whitespace,
  `(`, `[`, `{`, `>`, `*`, `_`, `~`, `=`, `%`, or quote — never mid-word
  (`a#b` is not a tag; also avoids URL fragments `page#section`).
- Next char after `#` must be a tag-start char (letter, `_`, or
  non-ASCII word char — **not** digit-only start, **not** space, **not**
  another `#`): enforces "directly followed by text" + "never numbers-only"
  (validate full token: at least one non-digit in `[A-Za-z0-9_\-/]` run;
  reject `#123`).
- Continue while `[A-Za-z0-9_\-/]`; `/` must be followed by a valid tag char
  (no trailing `/`, no `//`); stop at whitespace or punctuation
  (`. , ; : ! ? ) ] } "` etc.). `#project/active` is one node.
- Never fires at a position the block parser already claimed as `ATXHeading`
  (inline parsers run inside paragraph content, so `# H` at line start is
  already a heading — no extra guard needed beyond the no-space rule; still,
  register the parser `before: "Link"`/early so `#tag` inside emphasis/links
  resolves sanely, and explicitly return `-1` when `char(pos+1) === 32`.
- Inside `[[..]]`/`[...](...)`/code spans/HTML: lezer runs inline parsers in
  precedence order with `WikiLink before Link`; Tag should run **after**
  `WikiLink` (tags inside wikilink targets are link text, not tags) and base
  `Link`/`Image`/`InlineCode`/`HTMLTag` keep their natural priority — same
  ordering argument as `wikilinks.ts` header comment.

## HideMarkersPlugin + HighlightStyle seams (the second focus question)

`HideMarkersPlugin` (`hide-markers.ts:13-312`, `ViewPlugin.fromClass`):

- Walks `syntaxTree(view.state).iterate({from, to})` over `visibleRanges`,
  rebuilds on doc/selection/viewport/focus change; cursor-proximity rule
  (focused line / parent-intersection) decides show-vs-hide.
- Generic marker test: `type.includes("Mark") || includes("Delimiter") ||
  HeaderMark/CodeMark/CodeInfo/URL`. Inline surgical set today:
  `["Emphasis","StrongEmphasis","InlineCode","Link","Image"]` + special
  `LinkMark` (walk up to `Link`) and `URL`-inside-`Link` branches.
- Per-type rendering already proven: `ListMark`→`BulletWidget`/
  `md-list-number`, `HeaderMark` ATX→`replace` vs Setext→`md-faded`,
  `QuoteMark`→`replace`, `FencedCode`→`LanguageLabelWidget`,
  `WikiLink`→alias-aware `replace`.
- Extension points for this slice (no plugin rewrite): add
  `HighlightMark`/`HiddenCommentMark`/`FootnoteMark` handling to the generic
  replace-when-collapsed path; add `Strikethrough` to the parent-intersection
  list; `Tag`/`BlockRef` need only `mark` styling (no markers to hide —
  `Tag` has zero-width mark at most, `BlockRef` gets `md-faded` class);
  `%%` whole-node policy stays style-only per §11.

`HighlightStyle` (`highlight.ts:4-84`, `HighlightStyle.define`):

- Today: `heading1-6`, `strong`, `emphasis`, `quote`, `link/labelName`,
  `monospace`, `processingInstruction/meta/punctuation/separator→md-marker`,
  code token colors, `comment→code-comment italic`, `string`, `invalid`.
- Gaps: no `strikethrough` (tag exists, unused), no highlight/tag/footnote/
  hidden-comment/blockref rules.
- Extension pattern (same file, additive): each new `MarkdownConfig`
  contributes `styleTags({...})` mapping new nodes to existing tags
  (`Highlight→t.content` + class, `Tag→t.tagName`,
  `Footnote→t.link`, `HiddenComment→t.comment`, `BlockRef→t.meta`), and
  `highlight.ts` adds one rule per tag with a `cm-*` class for theme
  tokens — no new `@lezer/highlight` dependency needed.

## Recommended build order (for the spec author, not this ticket)

1. `Strikethrough` style+hide (no parser work — smallest).
2. `==Highlight==` `parseInline` + style + hide (Obsidian-first flagship,
   pattern for the rest).
3. `#Tag` `parseInline` + `tagName` style (disambiguation rule above).
4. `%%comment%%` `parseInline` + faded style (style-only, no hiding).
5. `Footnote` ref `parseInline` first (`[^..]` + `^[...]`, style only);
   `[^..]:` definition block handling deferred to builder slice with
   callout/table decisions.
6. `^block-id` trailing-anchor decoration (`parseInline` preferred,
   ViewPlugin fallback) + faded style.

Explicit non-goals confirmed by this research: enabling lezer `Emoji`,
`Subscript`/`Superscript` (conflict with strike/block-id, §18–19); full
transclusion/Reading preview (map Out of scope); `1)` renumber (lists.ts
note, separate slice).

## Sources

- `packages/ui/src/editor/index.ts` (sole-language comment;
  `[Table, GFM, WikiLinkExtension]`).
- `packages/ui/src/editor/extensions/{wikilinks,hide-markers,highlight,lists}.ts`.
- `packages/ui/package.json` + `bun.lock` (1.7.2 / 6.5.2 resolutions).
- `@lezer/markdown@1.7.2` `dist/index.js` (Type enum, `DefaultInline`,
  `GFM` def line, `CommentEnd`, `markdownHighlighting`) + `dist/index.d.ts`
  (exports, `InlineParser`/`MarkdownConfig`/`MarkdownParser.configure`,
  default parser-name lists).
- `@codemirror/lang-markdown@6.5.2` `dist/index.d.ts` (`markdown({extensions})`).
- `@lezer/highlight@1.2.3` `dist/index.js` (tag key inventory).
- `codemirror/view` docs (`ViewPlugin`, `Decoration.mark/widget/line/replace`).
- Obsidian first-party: `obsidian.md/help/obsidian-flavored-markdown`
  (extension table), `obsidian.md/help/syntax`, `obsidian.md/help/tags`.
- Local vault `Obsidian-Markdown-Formatting-Examples.md` (Basics, Headings,
  Lists, Tags & Properties inline, Footnotes, Comments, Block References,
  Other).
