# VCS Contract Test Suite

This directory contains the contract test suite for `VCSAdapter` implementations (`SpawnGitAdapter` and `IsomorphicGitAdapter`).

- **Pre-Merge Confidence Check & Gate**: See [`docs/vcs-contract-gate.md`](../../docs/vcs-contract-gate.md)
- **Architecture Decision Record**: See [`docs/adr/0004-contract-tests-with-real-git.md`](../../docs/adr/0004-contract-tests-with-real-git.md)
- **Specification**: GitHub Issue [#39](https://github.com/threehymns/np/issues/39)

## Running Contract Tests

```bash
bun test tests/contract/
```
