# Reproduce removal permission differences

Run these commands from the repository root with Node 24. The real Claude binary runs only inside the existing Seatbelt conformance runner. The runner uses the pinned Claude Code 2.1.312 digest and a local mock Messages server. No provider request leaves the machine.

1. Generate the fixed-seed corpus.

```sh
node packages/coding-agent/conformance/removal-fuzz.mjs generate
```

The generator writes 512 distinct shell lines and 16 conformance cases. Each case submits 32 independent Bash tool calls in one model turn and one session per side. The default seed is `328708`. Pass a decimal seed after `generate` to reproduce another corpus.

2. Build the full repository.

```sh
npm run build
```

3. Run the full conformance suite through the machine-wide lock.

```sh
"$PI_CC_STORE/ci-local/conformance-locked.sh" "$PWD"
```

Set `PI_CC_STORE` to the project store that contains the owner brief and the lock wrapper. Do not launch `conformance/run.ts` directly or bypass the isolation gate.

4. Record the oracle observations and compare them with the pure pi-cc permission evaluator.

```sh
node packages/coding-agent/conformance/removal-fuzz.mjs record
```

The recorder reads the completed run named in `conformance/.out/report.json`. It writes the oracle results to `removal-fuzz-fixtures.json` and every differing line to `.out/removal-fuzz-differences.json`. It exits with code 1 when any difference remains. An allowed command's execution output stays in the fixture for inspection. Only permission decisions and refusal messages enter the comparison. Token-budget system reminders and temporary root spellings are normalized.

5. Replay the recorded oracle without a shell or model server.

```sh
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/permissions-removal-corpus.test.ts
```

Every fixture row is asserted against `evaluatePermission` under `bypassPermissions`. The test also checks the corpus size, seed, uniqueness, and order. The current corpus has 431 matching commands and 81 open differences recorded in `removal-fuzz-open.json` for queue unit P04b. Those 81 rows use `it.fails`, so the test output names them as expected failures. A fix that closes one must remove its open row or the expected-failure assertion fails. This is not zero-diff evidence. The generated conformance cases prove safe completion and capture results, not permission parity by themselves. A future zero-diff corpus remains a bounded result, not a claim that all Bash syntax is covered.

The grammar includes assignment declaration keywords, literal and expanded values, tilde, braces, quotes, escapes, list operators, pipelines, groups, subshells, conditionals, loops, case statements, function definitions, command and process substitutions, backticks, function substitutions, and quoted and unquoted heredocs. Dedicated count cases cover depths zero through eight and the 63, 64, and 65 boundaries. Targets include workspace paths, parent paths, quoted globs, home paths, critical paths, seeded nonempty directories, and nonexistent paths.

The generator has no arbitrary shell-text input. It emits only `rmdir`, `true`, the `:` no-op, and loop control. There is no recursive removal, `rmdir -p`, overwrite, function invocation, or unbounded loop. Each workspace and its `sub` directory contain a seed file, so a missed permission check cannot remove either directory. `rmdir` cannot remove the filesystem root, `.` or `..`, or the nonempty system directories used by these probes. The pi-cc comparison never executes the generated commands.
