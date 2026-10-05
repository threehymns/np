# Research: how a machine without a language server gets one

Ticket #296 (map #291, feeds #284). Question: bundled npm package vs PATH
vs download, Node runtime, per-server binary overrides?

Sources: Zed checkout at `/tmp/opencode/zed` (sparse: 18 crates, no
`node_runtime`/`settings` sources — those claims rest on call sites only),
plus this repo (`apps/desktop/src/LspCommandResolver.ts`,
`packages/core/src/plugins/lsp/descriptors.ts`, ADR 0020).

## Zed: PATH first, download second, never bundled

Zed ships no language server in its own package. Every server resolves at
spawntime through one funnel.

### The funnel: `get_language_server_command`

`DynLspInstaller::get_language_server_command`
(`crates/language/src/language.rs:759`, blanket impl at :811, reached via
`CachedLspAdapter` at :385) returns `(existing_binary, Option<downloader>)`
and applies this order:

1. **User-installed (PATH/`which`)** — `check_if_user_installed`
   (default: `None`, `language.rs:708` trait `LspInstaller`). Gated by
   `binary_options.allow_path_lookup`. Deliberately **not cached**: each
   worktree may resolve a different binary (`language.rs` comment,
   ~:811-830).
2. **Cached download** — the in-memory `(pre_release, binary)` pair, only
   when the `pre_release` flag matches.
3. **Download** — needs `allow_binary_download` and a
   `delegate.language_server_download_dir(&name)` container dir. Returns the
   last `cached_server_binary` immediately *plus* a background
   `try_fetch_server_binary` (latest version → `check_if_version_installed`
   → `fetch_server_binary`). `lsp_store.rs:849-868` races the download
   against `SERVER_DOWNLOAD_TIMEOUT` (10s, `lsp_store.rs:183`): on timeout
   the existing binary wins and the download continues detached; on download
   failure it falls back to the previously downloaded binary. Download
   failures surface as `BinaryStatus::Failed`, never as silence.

The three knobs travel as `LanguageServerBinaryOptions
{ allow_path_lookup, allow_binary_download, pre_release }`
(`crates/lsp/src/lsp.rs:103-110`).

### Per-language install strategies (all implement `LspInstaller`)

- **Rust** (`crates/languages/src/rust.rs:748-920`): GitHub-releases
  download of rust-analyzer — per-OS `GITHUB_ASSET_KIND`/arch name, Linux
  libc detection (gnu vs musl). Integrity via stored SHA-256 digest plus a
  `--version` trial run before accepting a cached asset (`fetch_server_binary`
  at :831).
- **Go** (`crates/languages/src/go.rs:70-196`): `check_if_user_installed`
  finds `gopls` via `delegate.which` (:107); otherwise requires a `go`
  toolchain and runs `go install golang.org/x/tools/gopls@latest` into
  `<container>/gobin`, renaming to a versioned
  `gopls_{gopls_version}_go_{go_version}` and pruning the rest (:121-194).
  No `go` on PATH → install-time error with a one-shot notification.
- **TypeScript** (`crates/languages/src/typescript.rs:664+`): npm-based.
  `fetch_latest_server_version` resolves `typescript` (pinned to a
  `VersionReq`, :604) and `typescript-language-server` (latest) via
  `node.npm_package_latest_version*`; `check_if_version_installed` uses
  `node.should_install_npm_package` with `VersionStrategy::Pin` (TS, so a
  broken TS 7.x gets downgraded) vs `VersionStrategy::Latest` (server);
  `fetch_server_binary` runs `node.npm_install_packages` into the container
  dir. The "binary" is the **node binary itself**
  (`node.binary_path().await`), argv = `[<container>/node_modules/
  typescript-language-server/lib/cli.mjs, --stdio]` (`NEW_SERVER_PATH`,
  :614).
- **vtsls** (`crates/languages/src/vtsls.rs:97-182`): same npm pattern,
  package `@vtsls/language-server`, server path
  `node_modules/@vtsls/language-server/bin/vtsls.js` (:39-40); user check
  via `delegate.which("vtsls")` with the shell env attached (:108-120).

So: native servers download prebuilt binaries (GitHub or toolchain);
JS servers `npm install` into a per-server container and exec node against
the installed script. No server ever comes from Zed's own bundle.

### Node runtime

`NodeRuntime` (external crate — absent from this sparse checkout; API
reconstructed from call sites in `typescript.rs`/`vtsls.rs`): `binary_path`,
`npm_install_packages`, `npm_install_latest_packages`,
`npm_package_latest_version[_with_requirement]`,
`should_install_npm_package`. Zed can also manage Node itself: settings
carry `node.path` / `node.npm_path` plus `ignore_system_version`
(`NodeBinarySettings`, `crates/project/src/project_settings.rs:102-112`) —
"download its own copy of Node" when set.

### Per-server binary overrides (user settings win over everything)

`LspStore::get_language_server_binary` (`crates/project/src/lsp_store.rs:714`):

1. `settings.binary.path` (+ `arguments`, `env`) **short-circuits the whole
   funnel** — returned directly, no PATH lookup, no download (:725-755).
2. Otherwise the funnel runs with `allow_path_lookup =
   !binary.ignore_system_version`, `allow_binary_download`, `pre_release`
   from `fetch.pre_release` (:805-818).
3. After resolution, settings `arguments`/`env` overlay the binary's own
   (:874-884), merged over the delegate's shell env.

`BinarySettings` itself is re-exported from the `settings` crate
(`project_settings.rs:21`; source not in this checkout). Server start
additionally waits for worktree trust.

## This repo: bundled-first, PATH second, no download

### Descriptor owns the facts (ADR 0020, `descriptors.ts`)

ADR 0020 §"bundled" (line 15): which package a server ships as and which
script inside it runs is *descriptor data*, so the resolver needs no
per-server table. `LSP_DESCRIPTORS`
(`packages/core/src/plugins/lsp/descriptors.ts:34-49`) has one entry:
`command: 'vtsls'`, `args: ['--stdio']`,
`bundled: { package: '@vtsls/language-server', binary: 'bin/vtsls.js' }`.
A second server is a second entry (story 10).

### Resolver: two candidates, opposite order to Zed

`resolveLanguageServerCommand`
(`apps/desktop/src/LspCommandResolver.ts:374-395`, rationale :1-44):

1. **Bundled** — `<walk-root>/node_modules/<package>/<binary>` found by an
   upward walk (`bundledSearchRoots`, `MAX_WALK_LEVELS = 6`, `.unpacked`
   asar sibling first). This is what makes the PoC work on a machine with
   nothing installed. Runs as a **script** through `process.execPath` with
   `ELECTRON_RUN_AS_NODE=1` (:38-43).
2. **PATH** — POSIX: bare name left for `spawn` (+ shebang). Windows:
   explicit `PATHEXT`-style search (`.exe` > `.cmd` > `.bat`,
   `findCommandOnPath` :171-185), npm `cmd-shim` parsing to recover the JS
   target and run it via Electron-as-node (`shimScriptTarget` :202-223),
   `cmd.exe` fallback only when the shim is unreadable.

Never throws: no bundled candidate degrades to the bare command, and spawn
ENOENT surfaces as a start failure (`words: 'fallback'` stays intact).
Spec #263's "no other editors' install dirs" is a property of the walk
direction (up from app path, never sideways) and is asserted with sibling
bundles on disk. Input validation (`isValidLspCommandName`,
`isValidBundledCommand`, `isValidSpawnArgs`, `isValidSpawnCwd`, :309-372)
keeps renderer-supplied names from becoming execution.

### Node runtime and overrides: the gaps this ticket exposes

- **Node runtime**: the Electron binary itself (`ELECTRON_RUN_AS_NODE`),
  not a separately managed Node. No `node.path`/`npm_path` equivalent, no
  "download own Node" equivalent.
- **Download**: explicitly out of scope — "nothing here downloads or
  manages a binary" (`LspCommandResolver.ts:7-9`). A bare machine without
  the bundle gets ENOENT, not a fetch.
- **Per-server binary overrides**: no `LspSettings.binary`-style
  `{path, arguments, env, ignore_system_version}` layer; the only
  per-language switch is `editor.lsp` (document gating, ADR 0020), which
  never changes *which* binary runs.

## Comparison

| Concern | Zed | This repo |
|---|---|---|
| Bundled server in app package | Never | Candidate #1 (only offline story) |
| PATH lookup | Candidate #1 (`which`, uncached) | Candidate #2 (bare name / shim parse) |
| Download on missing server | Yes — GitHub / `go install` / `npm install` into per-server container dir | No — degrades to ENOENT |
| Node for JS servers | Managed `NodeRuntime` (+ own-Node download) | Electron-as-node |
| Per-server override | `lsp.<server>.binary.{path,arguments,env}` + `ignore_system_version`, `fetch.pre_release` | None (feeds #284) |
| Ordering guarantee | PATH beats download; settings beat all | Bundled beats PATH; nothing beats descriptor |

## Implication for #284

If #284 wants "machine without a server gets one" beyond the bundle, the
Zed-shaped pieces to port are, in dependency order: (a) a per-server
settings override (`binary.path/arguments/env`, short-circuiting
resolution — cheapest, no new machinery); (b) a download/install step per
descriptor (needs an installer counterpart to `LspCommandResolver` plus a
container dir and progress/status reporting — the largest piece, and the
one Zed spreads across `LspInstaller` + `lsp_store` + node runtime);
(c) managed-Node settings only if (b) covers npm-based servers. None of
(a)-(c) changes the descriptor type — consistent with ADR 0020's "second
server is configuration" line — but (b) does need a new host capability
behind `LSP_PLATFORM_SERVICE_KEY` (fetch + progress), i.e. a seam
extension, not just data.
