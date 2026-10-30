# Contributing

This is a private, operator-only fork (`just-joshn/pi-cc`). It does not accept outside issues or pull requests. Follow [AGENTS.md](AGENTS.md) for repository rules.

## Local workflow

```bash
npm install --ignore-scripts
npm run build         # refresh model data, then build all packages
npm run check         # lint, format, and type check (no tests)
./test.sh             # non-e2e tests
npm run conformance   # coding-agent conformance suite
./pi-test.sh          # run pi from source
```

Run `npm run check` after code changes and `./test.sh` before merging. Add changelog entries under `## [Unreleased]` per [AGENTS.md](AGENTS.md).
