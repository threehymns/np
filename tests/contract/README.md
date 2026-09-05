# VCS Contract Test Suite

This directory contains the contract test suite for `VCSAdapter` implementations (`SpawnGitAdapter` and `IsomorphicGitAdapter`).

- **Pre-Merge Confidence Check & Gate**: See [`docs/vcs-contract-gate.md`](../../docs/vcs-contract-gate.md)
- **Architecture Decision Record**: See [`docs/adr/0004-contract-tests-with-real-git.md`](../../docs/adr/0004-contract-tests-with-real-git.md)
- **Specification**: GitHub Issue [#39](https://github.com/threehymns/np/issues/39)

## Running Contract Tests

### Prerequisites

Dependencies must be installed first (a committed `bun.lock` is present, but
`node_modules` is not checked in). Without this, `bun test` fails locally with
module-resolution errors (`cannot find @codemirror/state`, `@np/core/*`, …):

```bash
bun install
```

### Run

```bash
bun test tests/contract/
```
