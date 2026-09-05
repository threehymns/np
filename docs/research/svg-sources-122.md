# #122 research: SVG source options for plain-DOM themed icons

## Verdict: both, split by producer

- **Phosphor → SVG-string table, build-time codegen, ui-side.** Zero runtime cost, no sanitization.
- **Zed/CDN → keep `url` + `<img>` default; opt-in fetch→sanitize→`svg` at plain-DOM call sites.** Preserves browser caching; inline only where Svelte can't mount.

Rejected: SVG-first-only (forces sanitize infra on every icon, loses `<img>` caching) and img-first-only (leaves autocomplete on emoji glyphs).

## What the `svg` variant covers today: nothing

`ResolvedIcon` declares `component | url | svg | empty` (`packages/core/src/editor/icons-types.ts:3-7`),
but `svg` has zero producers and zero renderers:

- `ManifestIconProvider` returns `url` only (`manifest-provider.ts:89,110,119,152,166,175,185,198,205`).
- `PhosphorIconProvider` returns `component` only (`packages/ui/src/editor/icons.svelte.ts:16-40`).
- `Icon.svelte:169-198` branches only `url`→`<img>` / `component`→`<IconComponent/>`; an `svg` value falls into the generic fallback.
- Chains pass variants through opaquely, so no registry-interface change is needed to activate `svg`.

## Key facts

- **Phosphor shape**: Svelte components, not SVG strings. Provider imports named components
  (`icons.svelte.ts:1`); each is a `.svelte` file with `$props()` (weight/color/size/mirrored) and
  per-weight path branches. No path-data table exists — SVG strings require build-time SSR/codegen
  from pinned `phosphor-svelte@3.1.0` (`packages/ui/package.json:40`), and must live in `ui`
  because core is Phosphor-free by invariant test (`headless-invariants.test.ts:18-25`).
- **Manifest CDN fetch/caching**: manifest JSON fetched (`fetchZedTheme`, `builtin-themes.ts:35-43`,
  bare fetch, null-on-fail) from jsDelivr for builtins (`builtin-themes.ts:11-33`); installed
  manifests cached in localStorage (`icons.svelte.ts:374-388`). Icon SVG bytes are never fetched
  by code — `resolveZedTheme` (`zed-format.ts:31-78`) only joins baseUrl+path to URL strings; the
  browser loads them via `<img>` with per-URL `failedUrls` fallback to Phosphor
  (`Icon.svelte:41,89-95`).
- **Sanitization**: none needed today (`<img>` can't execute SVG scripts; only `innerHTML` is
  hardcoded copy/check icons in `CopyButtonWidget.ts:17-18`). Inlining fetched Zed SVGs (arbitrary
  GitHub repos via `installThemeFromGitHub`, `icons.svelte.ts:315-342`) makes an allowlist
  sanitizer + https-only baseUrl validation mandatory. Build-time Phosphor strings need none.
- **Bundle cost**: `phosphor-svelte` is large on disk but tree-shaken via named/per-path imports —
  keep it that way. A build-time SVG table for the provider icons is single-digit KB. Zed inlines
  cost zero bundle but need lazy-per-icon LRU (never localStorage, never preload).
- **Plain-DOM hosts**: `WidgetType.toDOM()` widgets (`CopyButtonWidget`, `BulletWidget`,
  `LanguageLabelWidget`, `HorizontalRuleWidget`) and wikilink autocomplete
  (`wikilinks.ts:104-235`, emoji glyphs via `theme.ts:219-224`). No icon wiring yet.

## Proposed seam (input to #125 design)

- Add `Icon.svelte` `{:else if svg}` `{@html}` branch + a `resolveIconSvg()` helper
  (`svg`→as-is, `component`→table lookup, `url`→fetch/sanitize/LRU).
- Keep `ManifestIconProvider` returning `url`; no fetching in core.
- `theme.ts` / `wikilinks.ts` need no changes under this ticket.
