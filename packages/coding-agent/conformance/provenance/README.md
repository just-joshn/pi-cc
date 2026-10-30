# Dossier provenance

The harness writes its own sandbox policy in `../isolate.ts`. These two files are pinned copies of the
Claude Code RE dossier's probe profiles, kept so a reviewer can compare the policy shape the harness
derived against the shape it was derived from. Nothing reads them at runtime.

| file | dossier source | copy sha256 | live sha256, 2026-10-30 | sentinel-normalized sha256 (copy and live) |
|---|---|---|---|---|
| `probe-strict.sb` | `01a18607-9e4b-7380-9552-e121df0aa579/claude-code-re/runtime/sandbox/probe-strict.sb` | `b2939f058fa9cb235e8a7575e0d17498961a6dc7ab4fcfc6c610ebc5b24f1b26` | `2601e8f05cefe394223cd159f3fa1d6eb6a0c79286a939cb0c7e2652b5dcbaf8` | `af49adf0e7ca0a66e6d09a7ee90eec33eb10ddf479acedbc2f41e14eb969715b` |
| `probe-loopback.sb` | `01a18607-9e4b-7380-9552-e121df0aa579/claude-code-re/runtime/sandbox/probe-loopback.sb` | `8021269662b7b22c423e971ae1fa4b5d731ec8e1aeb4ae751f343dd8af32d646` | `9208655f10317f2812eba53e83f9135794a9eff26cc2b272ea6946ecfbb0573e` | `2e4aaeb641b144414f9010510b6f36ef6cd8e00e5de19b883f8a7ba669b11429` |

Copied 2026-10-29. The dossier snapshots (`projects/pi-cc/store/dossier-snapshot-20261029T0022/` and
`dossier-snapshot-final/`) do not carry `runtime/sandbox/`, so these are pinned from the live tree.
The copy digest is what makes the copy stable. Compared against the live profiles on 2026-10-30, only the
sentinel line differs: the last `(deny file-read* ...)` entry names the RE run's scratch directory
(`/private/tmp/claude-re-probe-<random>`), which changes on every run of the probe. Replacing that path with
`SENTINEL` in both the copy and the live file gives the same digest, the last column. The live digests
will keep moving for that reason alone. `../../test/conformance-provenance.test.ts` recomputes the copy and
normalized digests from the files in this directory, so a stale row fails the test.

What the harness took from them, all re-expressed for a general case root rather than the dossier's own
paths:

- default deny, then explicit allows, in that order, because Seatbelt applies the last matching rule;
- allow `process-exec*`, then deny the executables that read credentials or hand work to another app (`security`, `securityd`, `ssh-add`, `osascript`, `open`);
- deny every mach service, then allow back only the names in `ALLOWED_MACH_SERVICES`, which is empty
  because no case needs one. The dossier profiles allowed `mach-lookup` broadly and denied the Security
  and trust services; the harness narrowed that to an allowlist, so the pasteboard, Shortcuts, and
  LaunchServices services are unreachable too;
- allow reads broadly, then deny the real home, `/Library/Keychains`, `/private/var/db/dslocal` and the
  managed-policy roots (`/Library/Application Support/ClaudeCode` and `/private/etc/claude-code`, spelled
  canonically because `/etc` links to `/private/etc` and Seatbelt matches resolved paths), then re-allow the side's executable and its own root;
- deny writes broadly, then allow the side root and the `/dev` character devices;
- deny all network, then re-open loopback only for the case that needs the mock model server.

The harness adds the node runtime roots the fork needs, which the dossier profiles had no reason to
carry, and it pins paths through `realpathSync` because Seatbelt matches resolved paths.
