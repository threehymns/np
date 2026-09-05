# Research: CodeMirror render seam, reactivity, live-update cost (#123)

Child of map #121 — Themed icons in plain-DOM contexts, proven by autocomplete.
Method: code read only. No behavior change on this branch.

## 1. How the render() seam works

- The wikilink source is a **sync `CompletionSource`**: `wikilinkAutocompletion(context): CompletionResult | null`
  (`packages/ui/src/editor/extensions/wikilinks.ts:104-106`). It is registered per-language via
  `markdownLanguage.data.of({ autocomplete: wikilinkAutocompletion })`
  (`packages/ui/src/editor/index.ts:94-96`), with the engine enabled once globally by
  `autocompletion()` (`packages/ui/src/editor/index.ts:190`).
- Options carry `{ label, detail, type, apply }` with `type` in `file | section | variable`
  (`wikilinks.ts:146-154, 186-193, 204-209`). The `type` string is what CodeMirror maps to an
  icon slot via the CSS class `cm-completionIcon-<type>` (upstream `Completion.type` doc in
  `@codemirror/autocomplete` `index.d.ts`; restyled locally in
  `packages/ui/src/editor/extensions/theme.ts:219-224`, which adds `:after` glyphs for
  `file`/`section` because the base theme has no glyphs for them).
- The custom-icon seam is `CompletionConfig.addToOptions`: `{ render(completion, state, view): Node | null; position }`
  (upstream `index.d.ts` — "called for each visible completion"; default icons position 20, label 50, detail 80).
  **Render is synchronous and returns a `Node`.** The repo does **not** use `addToOptions` yet —
  there is no custom icon render today, only `type`-driven CSS glyphs.
- Reactive reads inside the source today are **Facets**: `workspaceFacet` / `currentDocFacet`
  (`wikilinks.ts:13-19`, `combine: values[0] ?? null`) read via `context.state.facet(...)`
  (`wikilinks.ts:115-116`; same pattern in `link-events.ts:148-149,189-190,210-211`).
  Facets re-read only when the source re-runs (typing / `validFor` expiry / explicit command).

## 2. The async gap + fallback story

- Registry init is async, resolution is sync. `IconRegistry.initialize()`
  (`packages/ui/src/editor/icons.svelte.ts:81-114`) fetches builtin Zed themes over jsDelivr
  (`fetchZedTheme`) plus `localStorage`-cached installed themes. Until that lands,
  `fileThemes = { phosphor }` only, and `resolveFileIconChain`
  (`icons.svelte.ts:183-214`) degrades gracefully to the phosphor chain
  (`|| this.fileThemes['phosphor']`, lines 184/217).
- `ManifestIconProvider` after construction is fully sync: `resolveFileIcon` is hash lookups
  over `fileStems`/`fileSuffixes`/`fileIcons` (`packages/core/src/editor/icons/manifest-provider.ts:82-157`),
  `setAppearance` is a sync variant re-resolve (`manifest-provider.ts:64-72`).
  The remaining async is transport: theme JSON fetch (once) and `<img>` URL decode (per icon).
- Therefore `render()` can **always return synchronously**:
  - First paint (registry not ready / URL not yet loaded): fixed-size placeholder slot (16px box) —
    phosphor-equivalent glyph or theme-default URL. Never a spinner; the popup shows tens of rows
    and lives for seconds, so a spinner is visual noise.
  - Swap when ready: `render()` kicks off the async (registry ready promise / `img.onload|onerror`)
    and **patches the returned Node in place** (`img.src = url` / `span.innerHTML = svg`).
    No CodeMirror transaction is needed — tooltip DOM lives outside `EditorState`.
    Guard with `node.isConnected` (tooltip recycles rows on scroll/filter).
  - Flicker policy: stable box size (no layout shift), swap `src`/content only, never re-sort
    or re-label (labels are theme-independent, so no re-filter). Broken URLs follow the
    `Icon.svelte` chain pattern: first non-failed URL in chain, else phosphor component fallback
    (`packages/ui/src/components/Icon.svelte:79-96,169-181`, `failedUrls` set at `42-52`).
  - Precedent for Svelte-side fallback chain: `resolveFileIconChain` returns
    `[activeIcon, activeDefault, phosphorIcon, phosphorDefault]` (`icons.svelte.ts:183-214`).

## 3. Does the registry support reactive reads? Facet / Compartment options

- **No.** `activeFileThemeId` / `activeProductThemeId` / `currentAppearance` are Svelte `$state`
  (`icons.svelte.ts:70-72`; headless mirror `packages/core/src/editor/icons/headless-registry.svelte.ts:10-12`).
  CodeMirror cannot see them. `context.state.facet()` only sees `workspaceFacet`/`currentDocFacet`.
  Theme changes propagate Svelte-side only: `prefs.onIconThemeChange` sets
  `icons.activeFileThemeId` (`packages/core/src/state.svelte.ts:114-120`), and
  `setAppearance` fans out to providers (`icons.svelte.ts:169-181`,
  `headless-registry.svelte.ts:43-55`, interface at `icons-types.ts:24,32,49`).
- Option A — **Facet carrying an icon snapshot** (e.g. `{ themeId, appearance, revision }`):
  - Pros: idiomatic CM reactive read (`state.facet`), sync, headless-testable
    (cf. `wikilinks.test.ts:216-217` `.of(mockWorkspace)`); revision bump re-queries the source.
  - Cons: host must forward every Svelte theme/appearance change into a CM transaction;
    the facet value must be an immutable snapshot, not a live registry ref, or reads go stale.
    Needed only if the *option list* depended on theme — it doesn't.
- Option B — **Compartment wrapping `autocompletion()` config**:
  - Pros: full `compartment.reconfigure(newConfig)` on theme change; precedent in-repo
    (`index.ts:168-180` wrap/language/vim compartments; `diff-extension-refresh.test.ts:7-28`).
  - Cons: heaviest tool for the job — reconfigures tooltip machinery for an icon-only change,
    and still does not repaint an open popup by itself.
- Option C — **neither; direct DOM patch (recommended)**:
  - Icon swap is a view-layer concern. On theme/appearance change, query the open
    `.cm-tooltip-autocomplete` rows and patch the icon slot nodes in place. No facet, no
    compartment, no transaction, no selection loss. Facet/Compartment buy nothing here
    because labels/ordering are theme-independent.

## 4. Perf cost estimate of live swap

- Popup scale: capped by `maxRenderedOptions` (upstream default 100); wikilink lists typically
  <15 visible rows after filtering (`wikilinks.ts:227-233`).
- Per-row live swap: one sync chain resolve (hash lookups over stems/suffixes,
  `manifest-provider.ts:82-157`, microseconds) + one DOM mutation (`img.src` swap).
  Total JS <1ms; image decode hits cache after first load (CDN URLs / localStorage theme cache,
  `icons.svelte.ts:134-143,374-388`). Fixed 16px slot ⇒ no layout shift.
- Full re-query alternative (`closeCompletion` + `startCompletion`): also CPU-cheap
  (tree file scan `getAllFilesFromTree` + filter, single-digit ms) but UX-expensive —
  drops selection/scroll and re-triggers `interactionDelay` (75ms) / `updateSyncTime` (100ms)
  defaults from upstream `CompletionConfig`. Flicker + selection loss is the real cost, not CPU.
- Change frequency: theme switch is rare (explicit user action). Light/dark appearance toggles
  are more frequent but **colors already track for free** via CSS vars
  (`theme.ts:177-214` popover/accent/radius tokens) — zero JS needed. Only icon *artwork*
  (manifest variant switch in `setAppearance`, `manifest-provider.ts:64-72`) needs a swap.

## 5. Firm recommendation: next-open sufficient; live patch only as a cheap bonus

- **Default: next-open is sufficient.** `render()` reads the registry synchronously on every
  popup open, so the next popup after a theme/appearance change is correct with zero extra code.
  Icons are decorative; popups live for seconds; worst case without live update is stale 16px
  glyphs until the popup reopens.
- **Bonus (cheap, no Facet/Compartment): if a popup is open during the change, patch its icon-slot
  DOM nodes in place.** ~10 lines at the `setAppearance`/theme-change call site; no transaction,
  no re-query, no selection loss. Fall back to next-open-only if the DOM query proves fiddly —
  that is an acceptable ship state, not a blocker.
- **Do not** add an icon Facet or reconfigure a Compartment for this: labels don't depend on
  theme, and both add transaction plumbing for zero visual gain over a DOM patch.
- Flicker policy: fixed-size slot, placeholder first paint, `src`-only swap, chain fallback
  (`Icon.svelte:79-96`) on URL error.

### Implementation sketch (for #127, the implement ticket)

1. Add `addToOptions` entry in the `autocompletion({...})` config (`index.ts:190`) whose `render`
   resolves `resolveFileIconChain(label)` synchronously and returns `<img>` (url) / `<span>` (svg/placeholder).
2. On `setAppearance` / `activeFileThemeId` change, if `.cm-tooltip-autocomplete` is present,
   re-resolve per visible row and patch `img.src` (guard `isConnected`).
3. Keep `type: file|section|variable` on options (`wikilinks.ts`) so headless tests and CSS glyph
   fallback (`theme.ts:219-224`) keep passing.
