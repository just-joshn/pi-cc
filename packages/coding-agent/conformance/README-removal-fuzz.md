# Differential fuzzer for dangerous-removal permission checks

The fuzzer compares pinned Claude Code 2.1.312 with pi-cc's `evaluatePermission` on generated shell lines. Claude runs only inside the existing Seatbelt conformance runner against the local mock Messages server. pi-cc's evaluator never runs a shell, and no provider request leaves the machine.

## Corpora

`removal-fuzz.mjs` holds seeded corpora of 512 distinct lines each.

| Name | Seed | Fixed lines | Files |
| --- | --- | --- | --- |
| `main` | `0x50404` (328708) | the six reviewer findings and a nesting-depth 0 to 8 by 0, 63, 64, 65 substitution sweep | `removal-fuzz-*` |
| `holdout` | `0x1badf00d` | none | `removal-fuzz-holdout-*` |
| `blind` | `0xc0ffee11` | none | `removal-fuzz-blind-*` |
| `blind2` | `0x0badcafe` | none | `removal-fuzz-blind2-*` |
| `review1` | 1986070319 | none, a reviewer's seed that found 1 unsafe line | `removal-fuzz-review1-*` |
| `review2` | 2991041723 | none, a reviewer's seed that found 3 unsafe lines | `removal-fuzz-review2-*` |
| `round6a` | 884213077 | none, recorded after the round 6 safe-side change | `removal-fuzz-round6a-*` |
| `round6b` | 1620481903 | none, recorded after the round 6 safe-side change | `removal-fuzz-round6b-*` |

The grammar combines assignment keywords (none, `export`, `local`, `readonly`, `declare`, `typeset`), value shapes (`.`, `..`, `/usr`, `/`, `~`, `$HOME`, `${HOME}`, single-quoted, double-quoted and escaped `$HOME`, quoted globs, a seeded directory, a nonexistent path, the empty string), the separators `;`, `&&`, `||`, `|`, `&` and newline, and these wrappers: subshell, group, `if`, `for`, `while`, `case`, a function definition, `$(...)`, backticks, `<(...)`, `>(...)`, `${ cmd; }`, and quoted and unquoted here-documents. Targets include `.`, `..`, `*`, `"*"`, `~`, `/usr`, `/`, `$HOME`, `$X`, `"$X"`, `'$X'`, `\$X`, `${X}/`, `$X/usr`, a seeded directory, `sub/..`, and a nonexistent path with and without `/..`.

The only commands are `rmdir`, `true`, the `:` no-op, `break` and assignments. The seeded workspace and its `sub` directory each hold a file, so `rmdir` cannot empty them. There is no recursive removal, overwrite, process spawning or unbounded loop. Each batch of 32 lines is one model turn with 32 Bash tool calls, so one Claude session per batch.

## Reproduce

Run these from the repository root with Node 24.

```sh
node packages/coding-agent/conformance/removal-fuzz.mjs generate main      # or any name in the table above; an optional fourth argument is a decimal seed
npm run build
"$PI_CC_STORE/ci-local/conformance-locked.sh" "$PWD"
node packages/coding-agent/conformance/removal-fuzz.mjs record main        # exits 1 while any difference remains
```

`PI_CC_STORE` is the project store that holds the machine-wide lock wrapper. Never start `conformance/run.ts` directly.

`record` reads the completed run named in `conformance/.out/report.json`, checks that each tool call still carries the generated command, and writes `<name>-fixtures.json` (the permission decision and refusal text Claude gave each line, plus the raw tool result), `<name>-open.json` (every line where pi-cc differs, with its direction) and `.out/<name>-differences.json`. Temporary root spellings and token-budget reminders are normalized. `record` exits 1 only when a line is `unsafe`.

## Directions

Each difference has one direction. `unsafe` means Claude asks and pi-cc allows, and is a safety bug that blocks a merge. `stricter` means Claude allows and pi-cc asks. `message-only` means both ask with different text. The module invariant in `removal.ts` keeps every difference on the safe side: when the model is unsure whether Claude binds a variable, it does not bind, so the variable-may-be-empty and critical-target checks fire. `stricter` and `message-only` rows are recorded P04b debt.

## Regression test

`test/permissions-removal-corpus.test.ts` asserts every fixture row against `evaluatePermission` under `bypassPermissions`, with no Claude binary and no shell. Every row where Claude asks must also be refused by pi-cc, so no corpus holds an `unsafe` row. A row listed in `<name>-open.json` is asserted with `it.fails`: it stays a known difference, never a passing row, and closing it forces its removal from the file. A passing corpus is a bounded result over this grammar, not proof for all Bash syntax. A new seed is the check for overfitting: expect a few `unsafe` lines from an unseen seed only if the invariant has a hole.
