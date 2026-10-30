# Contributing

This is a private, operator-only fork (`just-joshn/pi-cc`). It does not accept outside issues or pull requests. Follow [AGENTS.md](AGENTS.md) for repository rules.

## Local workflow

```bash
npm install --ignore-scripts
npm run build
npm run check
./test.sh
npm run conformance
./pi-test.sh
```

Run `npm run check` after code changes and `./test.sh` before merging. Add changelog entries under `## [Unreleased]` per [AGENTS.md](AGENTS.md).
