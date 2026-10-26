# Releasing the desktop app

Desktop releases are built from a semantic-version tag on `master`. The tag is
the source of truth for the app version: the release workflow writes it into
`apps/desktop/package.json` before packaging, so that file does not need to be
edited by hand.

## Cut a release

```sh
git switch master
git pull
git tag v1.2.3
git push origin v1.2.3
```

The tag must match `v<major>.<minor>.<patch>` and may include semver
prerelease/build suffixes (for example `v1.2.3-rc.1`). The workflow rejects
tags whose commit is not on `master`.

The `release-desktop` workflow then:

1. Runs the test suite, type checks, and a production build.
2. Builds installers on Linux x64, Windows x64, macOS Intel, and macOS Apple
   Silicon.
3. Uploads only installer files, not unpacked app directories.
4. Creates a **draft** GitHub Release with auto-generated notes. Publish it
   manually once the artifacts have been checked.

Tags with a prerelease suffix — a hyphen in the version part, as in
`v1.2.3-rc.1` — are marked as prereleases. Build metadata such as
`v1.2.3+build-5` does not make a prerelease, and purely numeric prerelease
identifiers must not carry leading zeroes (`v1.2.3-01` is rejected).

## Build output layout

Build output stays package-local, which is the normal monorepo layout: each
package owns the output of its own toolchain, and root-level scripts only
delegate to workspaces.

| Directory | Produced by | Contents |
| --- | --- | --- |
| `apps/desktop/dist` | Vite | Renderer bundle |
| `apps/desktop/dist-main` | `tsc -p tsconfig.main.json` | Electron main process and preload |
| `apps/desktop/dist-electron` | electron-builder | Installers and unpacked staging output |

All three are ignored by git. `bun run build:desktop` removes `dist-main`
first because `tsc` leaves stale files behind when sources are renamed or
deleted. Vite empties `dist` itself, and `dist-electron` is kept between local
builds.

## Installers

| Platform | Architectures | Files |
| --- | --- | --- |
| Linux | x64 | `.AppImage`, `.deb` |
| Windows | x64 | NSIS `.exe` |
| macOS | x64, arm64 | `.dmg`, `.zip` |

The `.zip` on macOS is produced alongside the `.dmg` for users who need an
archive rather than a disk image.

## Code signing and notarization

Signing is optional. When the secrets below are absent, electron-builder logs
a warning and produces unsigned artifacts. Add the secrets in the repository's
Actions settings before publishing a release that users should install without
security warnings.

### macOS

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application `.p12` certificate or a URL to it |
| `MAC_CSC_KEY_PASSWORD` | Password for the `.p12` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Apple Developer team ID |

All five must be present for a signed and notarized build. electron-builder
notarizes automatically when the Apple credentials are available.

### Windows

| Secret | Purpose |
| --- | --- |
| `WIN_CSC_LINK` | Base64-encoded code-signing certificate or a URL to it |
| `WIN_CSC_KEY_PASSWORD` | Password for the certificate |

Linux builds are not signed.

## Local checks

```sh
bun install --frozen-lockfile
bun test
bun run check
bun run build
bun --filter desktop dist:dir   # packaging smoke test, no installer
```

To reproduce the version injection locally:

```sh
RELEASE_TAG=v1.2.3 bun --filter desktop set-version
```
