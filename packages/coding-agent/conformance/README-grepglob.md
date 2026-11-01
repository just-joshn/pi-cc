# Grep and Glob conformance coverage

This suite pins user-facing Claude Code 2.1.312 Grep and Glob behavior for the pi-native implementation. Its evidence is the owner's `store/grepglob-probe/report.md`, the recorded tool results under `store/grepglob-probe/results/`, the request captures, and the schema captures. Those files are research inputs, not runtime dependencies of these fixtures.

`grepglob-fixtures.mjs` generates 51 JSON cases in `cases/grepglob/`. Both sides are applicable to every case. Four positive subagent cases have `skip: ["spec-gap"]` because the P19 Agent implementation is absent. The dedicated ToolSearch execution case has the same skip for P34. These five cases are skipped, not passed. The remaining 46 cases are executable definitions, not a claim that either side has passed them.

## Case construction

The generator uses the existing case format and mock model tool calls. Assertions inspect the next model request's `messages` for a `tool_result` with the expected tool-use ID and exact content. They accept either a string or exactly one text block carrying that same text, because the existing P10 transport debt encodes pi results as a block array. Search-result assertions do not permit extra blocks or a substring match. The bare Task rejection is the sole wording exception described below. Error cases require `is_error: true`. Success cases reject that flag. The generator's `--check` also rejects synthetic wrong IDs, wrong error flags, wrong text, and extra blocks for both wire encodings. Existing request comparison code is unchanged. Request counts detect missing calls. Tool exposure assertions inspect both the init frame and the request's actual `tools` array rather than prompt mentions of a tool name.

The `t10-settings-deny-bash` and `permission-deny-filter-and-cap` cases seed `$AGENT/trust.json` with a trusted `$WORKSPACE`. This lets pi load the seeded repository settings. The cases test settings-deny behavior, not the separate repository-trust gate. Runtime trust handling is unchanged.

Every case routes Claude's temporary files to the isolated `$TMP` with `CLAUDE_CODE_TMPDIR`. Ordered cases set distinct fixture mtimes with static `touch -t` commands through the sandboxed Bash tool. Every preparation call must return `SEARCH_FIXTURE_PREPARED` before its search assertions can pass. They never change host files. Glob ties and Grep content/count directory results assert membership and cardinality, not filesystem traversal order. Single-file content, context, and pagination retain their meaningful line order.

All schema assertions require the captured draft URI, property names and order, types, enum values, required array, and `additionalProperties: false`. They accept two structurally exact serialized variants, the captured schema key order and the native TypeBox key order. A local TypeBox-only inspection confirmed the native root order `type,required,properties,additionalProperties,$schema`, field order `type,description`, and enum-field order `type,description,enum`. Accepting the two serializer orders does not change the comparison API. The transport preserves the complete explicitly unconstrained schema rather than dropping its draft URI and additional-properties constraint. The generator's self-check rejects missing schema keys, changed constraints, changed description lengths, extra eager-tool keys, and reordered properties in both variants. They reject extra properties, including `_host`, and require `head_limit` and `offset` to be plain numbers. Schema field descriptions may contain any string. Tool descriptions are checked only for 140 Glob characters and 477 Grep characters. No captured descriptions or prompt text are copied. A complete tool-object match also excludes `strict`, `defer_loading`, and `eager_input_streaming` on these eager tools.

## Exposure matrix

Case names below omit the `grepglob/` prefix. The 18 main-session launch cases assert Grep/Glob presence or absence in both locations and exact eager schemas when exposed. Only explicit `--tools` subsets and bare sessions pin complete request tool-name lists. Default and opt-in launches do not assert unrelated Agent, ToolSearch, or other pending units' declarations or counts.

| Report row | Trigger | Durable case | Status |
| --- | --- | --- | --- |
| 1 | Default launch | `t01-default` | Runnable |
| 2 | `--bare` | `t02-bare` | Runnable |
| 3 | `--allowedTools Grep` jointly exposes both | `t03-allow-grep` | Runnable |
| 4 | `--allowedTools Glob` jointly exposes both | `t04-allow-glob` | Runnable |
| 5 | `--tools Glob,Read` exposes Glob only | `t05-tools-glob-read` | Runnable |
| 6 | `--tools Grep,Glob,Read` | `t06-tools-grep-glob-read` | Runnable |
| 7 | `CLAUDE_CODE_ENTRYPOINT=local-agent` | `t07-local-agent` | Runnable |
| 7b | Underscore spelling `local_agent` | `t12a-local_agent` | Runnable |
| 8 | Bash disallowed by flag re-adds both | `t08-disallow-bash` | Runnable |
| 9 | Removing Bash with `--tools Read,Edit` does not re-add | `t09-tools-read-edit` | Runnable |
| 10 | Settings deny Bash re-adds both | `t10-settings-deny-bash` | Runnable |
| 11 | Explicit subagent `Grep, Glob` under default launch | `t11-subagent-default` | P19 spec-gap skip |
| 11b | Same subagent under parent Grep opt-in | `t11b-subagent-allow-grep` | P19 spec-gap skip |
| 11c | Explicit subagent list bypasses parent Grep deny | `t11c-subagent-disallow-grep` | P19 spec-gap skip |
| 11d | Explicit subagent `Bash, Grep, Glob` gets Bash only | `t11d-subagent-bash-grep` | P19 spec-gap skip |
| 11e | Bare launch with an explicit agent list | `t11e-subagent-bare` | Runnable negative Task call. See capture correction below. |
| 12a | Bare beats Grep opt-in | `t12b-bare-allow-grep` | Runnable |
| 12b | Bash and Grep denied leaves Glob only | `t12c-disallow-bash-grep` | Runnable |
| 12c | Grep denial alone leaves neither | `t12d-disallow-grep` | Runnable |
| 12d | Explicit Bash,Read leaves neither | `t12e-tools-bash-read` | Runnable |
| 12e | Scoped Grep permission opts in jointly | `t12f-allow-scoped-grep` | Runnable |
| 12f | Explicit default list | `t12g-tools-default` | Runnable |
| 12g | Explicit Read only | `t12h-tools-read` | Runnable |
| 12h | Raw SIMPLE env, Windows, wildcard agent | No measured row to reproduce | Open, not passed |

The four P19 cases assert the exact subagent request tool-name list. The three that expose Grep/Glob also assert the same schemas and description lengths inside the subagent request. They must lose their skips only after P19 integration and locked two-sided execution. The test harness does not implement or simulate Task/Agent.

`schema-joint-opt-in` pins both tools on a main request. `schema-explicit-glob` pins Glob when Grep is absent. `toolsearch-not-an-exposure-route` defines tests for both `select:Grep,Glob` and a keyword query. Neither query may expose these tools or return their tool references. This case remains a P34 spec-gap skip. Native `tool_search` exists under that name in `src/extensions/tool-search`, but `cc-surface.ts` has no `ToolSearch` alias. The harness does not add one. Eager schema declarations and absent-tool assertions remain runnable in the launch cases.

## Report section 4 behavior map

| Finding | Durable case or cases | Assertion |
| --- | --- | --- |
| Glob oldest-mtime-first order | `glob-order-and-patterns` | Four nested TypeScript files in ascending mtime order. |
| Glob 100-result cap takes oldest files | `glob-cap-oldest-100` | Exact f120 through f021 list and exact 100-of-120 suffix for pattern and path forms. |
| Permission-aware Glob truncation hides total | `permission-deny-filter-and-cap` | Exact alternate suffix, no count disclosure. |
| Denied files omitted with no suffix below cap | `permission-deny-filter-and-cap` | Both allowed tie files and no extra text. |
| Glob tie order follows backend traversal | `glob-ties-membership-grep-ties-alpha` | All three tied files. Deliberately no tie-order contract. |
| Hidden, ignored, log, module, and `.git` files listed | `glob-hidden-ignored-vcs-modules` | Exact singleton results and complete `.git` membership. |
| Case sensitivity, braces, recursion, scoped patterns | `glob-order-and-patterns` | Exact no-match text, brace membership, and directory-relative results. |
| Absolute pattern | `glob-empty-and-absolute-pattern` | `/etc/hosts` is returned as an absolute path. It is not modified. |
| Empty pattern lists files | `glob-empty-and-absolute-pattern` | Both files in the small fixture tree. |
| Parent components in pattern do not normalize | `glob-order-and-patterns` | `docs/../src/*.ts` returns `No files found`. |
| Glob relative output under cwd | `glob-order-and-patterns`, `glob-hidden-ignored-vcs-modules` | Paths retain workspace-relative prefixes, including a supplied subdirectory. |
| Glob outside-cwd path produces absolute output | `glob-external-paths-absolute` | An isolated sibling of the session cwd produces an absolute workspace path. No broad `/usr` search. |
| Glob no match, missing directory, file target | `glob-order-and-patterns`, `glob-path-errors` | Exact texts and error flags; only the generated cwd is variable. |
| Glob unreadable directory | `unreadable-targets-and-partial-search` | Exact refusal text and error flag, with variable absolute workspace prefix. |
| Grep default and explicit files mode | `grep-files-default-newest-and-singular` | Same complete newest-first list, exact plural and singular headers, exact no-match text. |
| Grep alphabetical ties | `glob-ties-membership-grep-ties-alpha` | Exact t1, t2, t3 order. |
| Grep content/count traversal is unordered | `grep-content-rendering`, `grep-count-format`, `permission-deny-filter-and-cap` | Membership and cardinality only across multiple files. |
| Content directory versus single-file prefixes | `grep-content-rendering` | `path:line:text` versus `line:text`. |
| Default, explicit true, and false `-n` | `grep-content-rendering` | Exact numbering behavior for directory and file targets. |
| Context `-B`, `-A`, `-C`, and `context` | `grep-context-and-only-matches` | Exact context line separators and ranges. |
| `-C` overrides `-A` | `grep-context-and-only-matches` | Only the requested symmetric context appears. |
| Context ignored in files mode | `grep-context-and-only-matches` | Only a file header and path. |
| `-o` returns matched text | `grep-context-and-only-matches`, `grep-case-type-and-glob` | Exact match text, including insensitive matches in multiple files. |
| Matching line over 500 columns omitted | `grep-long-line-omission` | Exact omission marker, not the original long line. |
| Content no match | `grep-content-rendering` | Exact `No matches found`. |
| Count lines, totals, singular nouns, and zero format | `grep-count-format` | Every count line and exact summary, including independent occurrence/file pluralization, blank line, and zero case. |
| Count pagination summary retains whole-search totals | `grep-count-pagination` | Three valid count entries and exact 120-file totals, with both limit and offset suffixes. Selection order remains unconstrained. |
| Content default limit 250 | `grep-content-pagination` | Exactly the first 250 single-file lines and exact footer. |
| Files limit, offset, zero unlimited, numeric string | `grep-files-pagination` | Exact newest-first page membership and headers, including offset 118 and string `"3"`. |
| Files offset past end | `grep-files-pagination` | Exact single-line no-entries message. |
| Content limit, offset, zero unlimited, past end | `grep-content-pagination` | Exact pages and footer placement, including the past-end blank line. |
| Case-insensitive matching | `grep-case-type-and-glob` | Both case variants appear and the sensitive control finds none. |
| Known and unknown file types | `grep-case-type-and-glob`, `grep-validation-and-search-errors` | ts/md membership and exact unknown-type error. |
| Positive, brace, and negative globs | `grep-case-type-and-glob` | Complete allowed membership for each filter and combined type/glob input. |
| Multiline false, true, and dotall | `grep-multiline` | No-match control and exact two-line matches. |
| VCS directories excluded | `grep-vcs-hidden-ignore-modules` | No result from `.git`, `.svn`, `.hg`, `.bzr`, `.jj`, or `.sl`. |
| Hidden and node_modules included | `grep-vcs-hidden-ignore-modules` | Both files are in the exact allowed set. |
| Gitignore honored with `.git` | `grep-vcs-hidden-ignore-modules` | Ignored directory and log file are absent. |
| Gitignore ignored without `.git` | `grep-ignore-without-git` | Both ignored files appear. |
| Workspace Library/Containers searched | `grep-vcs-hidden-ignore-modules` | Container file appears normally. |
| Invalid output mode, negative pagination, missing pattern | `grep-validation-and-search-errors` | Captured multiline validation error text and error flags. |
| Bad regex | `grep-validation-and-search-errors` | Exact wrapped `(?:(foo)` diagnostic and error flag. |
| Missing Grep path | `grep-validation-and-search-errors` | Exact diagnostic except generated cwd. |
| Unreadable Grep file and directory | `unreadable-targets-and-partial-search` | Exact EACCES/refusal diagnostics and error flags. |
| Read-rule denial on explicit file | `permission-deny-filter-and-cap` | Exact denial text except generated absolute prefix. |
| Read-rule filtering in directory search | `permission-deny-filter-and-cap` | 111 allowed files, plus filtered count and content membership. |
| Unreadable subtree preserves other results and no-match | `unreadable-targets-and-partial-search` | Normal success and all three normal no-match formats despite the unreadable child. Permissions are restored before the final response. |
| FIFO timeout after 20 seconds | `grep-fifo-timeout` | Exact timeout error. The fixture FIFO is unlinked before exit. No elapsed-time performance claim. |
| Large output persistence and preview | `grep-persisted-output-numbered`, `grep-persisted-output-unnumbered` | Exact size labels, absolute tool-result filename, 2KB-preview label, first line, ellipsis, and closing tag. A later Bash call checks that the saved file contains the 250th selected line but not the 251st. |
| Million-line content cut | No case. `GREPGLOB-buffer` below. | Open proposed deviation, not accepted parity. |

## Harness dependency preparation

`allowlist.ts` adds only `Grep`, `Glob`, and `CLAUDE_CODE_ENTRYPOINT`. The `default` argument was already allowed. It does not add the probe-only filter or `USE_BUILTIN_RIPGREP`.

The harness PATH intentionally has no `rg`. `sides/pi-cc.ts` resolves `/opt/homebrew/bin/rg` to the installed ripgrep executable, audits its dependencies with `/usr/bin/otool -L`, and copies it into the isolated `PI_CODING_AGENT_DIR/bin/rg`. This is the directory returned by pi's `getBinDir()`. It never invokes pi's download path or Claude's embedded backend.

The audit permits system dylibs and the recorded PCRE2 install name only. The resolved PCRE2 file is added to the side's read roots, not its parent directory. On this host it is `/opt/homebrew/Cellar/pcre2/10.49/lib/libpcre2-8.0.dylib`. No network, write, or keychain sandbox grants change. Missing binaries, missing libraries, or an unreviewed non-system dependency fail with an explicit harness dependency error. No download is attempted.

## Capture corrections

The raw requests are more precise than two statements in the report.

- `results/raw/t11e-subagent-bare/requests.jsonl.gz` contains two main requests and an unknown-Task error. There is no subagent request. The runnable case pins the exact Bash/Edit/Read tool list, absent Grep/Glob declarations, two-request count, and unavailable-Task error prefix with `is_error: true`. It does not assert Task's trailing error wording or claim full Task error parity. The statement that a bare subagent ignored its explicit list and received Bash/Edit/Read is not proved by this capture.
- `results/raw/d02-toolsearch/requests.jsonl.gz` shows that the keyword query returned references to other deferred tools. The result was not empty. The confirmed parity requirement is that Grep and Glob are not returned and do not become request tools.

## Open parity debt and proposed deviations

Only the operator can approve a deviation. These entries are follow-up proposals, not waivers or passes. The coordinator must carry them into `store/deviations.md` and the PR's follow-up list.

| ID | Queue owner | Exact gap | Required closure |
| --- | --- | --- | --- |
| `GREPGLOB/P19` | P19 Agent/subagent integration, then GREPGLOB | Exposure rows 11, 11b, 11c, and 11d cannot execute on pi-cc because Task/Agent is absent. Four durable two-sided definitions remain spec-gap skips. | Integrate real pi-native subagents, remove those four skips, and run the locked two-sided cases. Add actual subagent Grep/Glob tool execution as well as schema assertions. No harness-side Task simulation. |
| `GREPGLOB/P34` | P34 deferred tool loading and ToolSearch | The dedicated `toolsearch-not-an-exposure-route` case cannot execute because the native `tool_search` extension is not aliased to CC `ToolSearch`. It remains a two-sided spec-gap skip. | Implement the real pi-native alias and result behavior in P34, remove the skip, and run the locked case. No harness simulation. |
| `GREPGLOB/P19-wording` | P19 Task/Agent errors, with P03 registry error shape | CC 2.1.312 appends `Task is not among the tools available here. Continue with the tools you have.` after the unavailable-Task prefix. Pi currently ends the generic unknown-tool error immediately after `Task`, without CC's period or suffix. The runnable bare case leaves the suffix unconstrained, not passed as parity. | Implement the real Task error wording in P19/P03 and add an exact two-sided assertion there. Do not alter the harness or search runtime to simulate Task behavior. |
| `GREPGLOB/P19-bare` | P19, then GREPGLOB probing | The report's positive bare-subagent tool-list claim is not supported by the raw capture. Only Task rejection was observed. | Probe an actual reachable bare-agent route if one exists. Do not infer a subagent tool list from main-session tools. |
| `GREPGLOB-buffer` | GREPGLOB follow-up | A 26 MB, 1,000,000-line input produced only 69,630 complete persisted content lines on the reference, with and without numbers. The final line had no trailing newline. An isolated native rg JSON experiment with a 20 MiB cap returned 101,563 complete matches in `store/grepglob-buffer-check.mjs`. The runtime uses a provisional decimal 20 MB collection cap, not a fixed line count. Neither limit explains the observed reference cut. The cause of the reference cut remains unknown. | Identify and reproduce the reference limit using pi-native code, or obtain an explicit operator deviation. Add a bounded generated large-input case and persisted-file count check. The current harness's 8 MiB workspace-read cap prevents naively seeding or leaving a 26 MB file in the workspace. Count mode must independently retain the full million occurrences. |
| `GREPGLOB-thresholds` | GREPGLOB follow-up | Exact Grep 20,000-character and Glob 100,000-character thresholds were not bisected. The two persistence cases cover measured 28.2KB/27.3KB output, not the boundary. Glob's 100-result cap and macOS PATH_MAX prevent an ordinary 100,000-character listing. | Bisect observable Grep output around the boundary with short lines. Establish a reachable Glob scenario or use a focused boundary test outside the CLI harness, with its limitation documented. |
| `GREPGLOB-platform-model` | GREPGLOB follow-up | Other models and versions, Windows/Linux, raw `CLAUDE_CODE_SIMPLE`, wildcard subagents, restricted sessions, managed-rule-only construction, and hook/held-inline deferral remain unprobed. | Gather platform/model-specific evidence before adding parity claims. |

The embedded reference executable and `USE_BUILTIN_RIPGREP` process observations in section 3 are not runtime mechanisms for pi-cc. The native dependency remains ripgrep through pi's existing tool manager. No test requires the pi backend to be the Claude binary. Internal rg argv and process cwd are not asserted by these user-facing cases.

## Validation and execution ownership

Regenerate or check the fixture definitions without starting either side:

```sh
node packages/coding-agent/conformance/grepglob-fixtures.mjs
node packages/coding-agent/conformance/grepglob-fixtures.mjs --check
node packages/coding-agent/conformance/run.ts --list
```

The delegate ran generation, freshness checking, and loader/list validation only. It also checked 59 result assertions and the exposure/schema definitions against already recorded captures without starting a side. A dependency-only smoke check copied and executed the isolated ripgrep with `--version`, verified its SHA-256 against the host executable, and confirmed the profile still denies network and external writes. No Claude execution, conformance case execution, provider call, or lock operation occurred.

Locked conformance execution and the root check/build/test gates remain the coordinator's responsibility. The four P19 skips, the P34 skip, and the open buffer/threshold debts prevent a claim of full parity even if all 46 runnable cases pass.
