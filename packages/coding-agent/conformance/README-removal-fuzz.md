# Differential fuzzer for dangerous-removal permission checks

The fuzzer compares pinned Claude Code 2.1.312 with pi-cc's `evaluatePermission` on generated shell lines. Claude runs only inside the existing Seatbelt conformance runner against the local mock Messages server. pi-cc's evaluator never runs a shell, and no provider request leaves the machine.

## Corpora

`removal-fuzz.mjs` holds four seeded corpora of 512 distinct lines each.

| Name | Seed | Fixed lines | Files |
| --- | --- | --- | --- |
| `main` | `0x50404` (328708) | the six reviewer findings and a nesting-depth 0 to 8 by 0, 63, 64, 65 substitution sweep | `removal-fuzz-*` |
| `holdout` | `0x1badf00d` | none | `removal-fuzz-holdout-*` |
| `blind` | `0xc0ffee11` | none | `removal-fuzz-blind-*` |
| `blind2` | `0x0badcafe` | none | `removal-fuzz-blind2-*` |

The grammar combines assignment keywords (none, `export`, `local`, `readonly`, `declare`, `typeset`), value shapes (`.`, `..`, `/usr`, `/`, `~`, `$HOME`, `${HOME}`, single-quoted, double-quoted and escaped `$HOME`, quoted globs, a seeded directory, a nonexistent path, the empty string), the separators `;`, `&&`, `||`, `|`, `&` and newline, and these wrappers: subshell, group, `if`, `for`, `while`, `case`, a function definition, `$(...)`, backticks, `<(...)`, `>(...)`, `${ cmd; }`, and quoted and unquoted here-documents. Targets include `.`, `..`, `*`, `"*"`, `~`, `/usr`, `/`, `$HOME`, `$X`, `"$X"`, `'$X'`, `\$X`, `${X}/`, `$X/usr`, a seeded directory, `sub/..`, and a nonexistent path with and without `/..`.

The only commands are `rmdir`, `true`, the `:` no-op, `break` and assignments. The seeded workspace and its `sub` directory each hold a file, so `rmdir` cannot empty them. There is no recursive removal, overwrite, process spawning or unbounded loop. Each batch of 32 lines is one model turn with 32 Bash tool calls, so one Claude session per batch.

## Reproduce

Run these from the repository root with Node 24.

```sh
node packages/coding-agent/conformance/removal-fuzz.mjs generate main      # or holdout, blind, blind2; an optional fourth argument is a decimal seed
npm run build
"$PI_CC_STORE/ci-local/conformance-locked.sh" "$PWD"
node packages/coding-agent/conformance/removal-fuzz.mjs record main        # exits 1 while any difference remains
```

`PI_CC_STORE` is the project store that holds the machine-wide lock wrapper. Never start `conformance/run.ts` directly.

`record` reads the completed run named in `conformance/.out/report.json`, checks that each tool call still carries the generated command, and writes `<name>-fixtures.json` (the permission decision and refusal text Claude gave each line, plus the raw tool result) and `.out/<name>-differences.json`. Temporary root spellings and token-budget reminders are normalized.

## Regression test

`test/permissions-removal-corpus.test.ts` asserts every fixture row against `evaluatePermission` under `bypassPermissions`, with no Claude binary and no shell. A line that cannot be closed goes into `<name>-open.json` and is asserted with `it.fails`, so closing it forces the row's removal. A passing corpus is a bounded result over this grammar, not proof for all Bash syntax. A new seed is the check for overfitting. `blind` was recorded after the rules were fitted to `main` and `holdout`, and 5 of its 512 lines differed. `blind2` was recorded after fitting `blind`, and 5 of its 512 lines differed. All four corpora now match, so expect a few differences, about 1 percent, from the next unseen seed.
