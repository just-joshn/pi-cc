# Configuration

Pi supports user-level and project configuration. User-level configuration lives in the agent directory, which defaults to `~/.pi/agent`. Project configuration lives in `.pi` under the working directory and loads after [project trust](security.md#understand-project-trust) is granted. The only exception is `sessionDir`, which Pi reads before resolving trust so it can locate sessions.

In interactive mode, use `/settings` to change common preferences. For other options, ask Pi to update the configuration or edit the relevant files directly. Run `/reload` after manually changing settings, keybindings, instructions, or resources.

## Agent directory

The agent directory is shown as `<agent-dir>` below. Set its location with the `PI_CODING_AGENT_DIR` environment variable or the SDK's [`agentDir`](sdk.md) option.

| Path | Responsibility |
|---|---|
| `<agent-dir>/settings.json` | User-level [settings](settings.md), including preferences, defaults, resource paths, and Pi package declarations. |
| `<agent-dir>/keybindings.json` | Custom terminal UI and application [keybindings](keybindings.md). |
| `<agent-dir>/mcp.json` | [MCP servers](mcp.md) available in every project. |
| `<agent-dir>/models.json` | [Compatible endpoints, models, and model overrides](models.md#configure-a-compatible-endpoint). |
| `<agent-dir>/auth.json` | Saved API keys and OAuth credentials. |
| `<agent-dir>/AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | User instructions applied across working directories. |
| `<agent-dir>/SYSTEM.md` | Replaces Pi’s default system prompt. |
| `<agent-dir>/APPEND_SYSTEM.md` | Adds instructions to Pi’s system prompt. |
| `<agent-dir>/extensions/` | User [extensions](extensions.md). |
| `<agent-dir>/skills/` | User [skills](skills.md) and supporting files. |
| `<agent-dir>/prompts/` | User [prompt templates](prompt-templates.md) exposed as slash commands. |
| `<agent-dir>/themes/` | User [theme](themes.md) files. |

## Project `.pi` directory

| Path | Responsibility |
|---|---|
| `.pi/settings.json` | Project-level [settings](settings.md), resource paths, and Pi package declarations. |
| `.pi/mcp.json` | Project [MCP servers](mcp.md). |
| `.pi/SYSTEM.md` | Replaces the system prompt for the project. |
| `.pi/APPEND_SYSTEM.md` | Adds project-specific instructions to the system prompt. |
| `.pi/extensions/` | Project extensions. |
| `.pi/skills/` | Project skills and supporting files. |
| `.pi/prompts/` | Project prompt templates exposed as slash commands. |
| `.pi/themes/` | Project theme files. |

For `SYSTEM.md` and `APPEND_SYSTEM.md`, the trusted project file takes precedence over the corresponding agent-directory file. Files with the same name are not combined.

## Context files

Context files are separate from project `.pi` configuration. Pi loads one context file from the agent directory into the system prompt: the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD`.

Pi loads project instruction files as Claude Code memory, which it sends with the first user message instead of the system prompt. For the working directory and each parent directory, from the top down, Pi loads `CLAUDE.md`, `.claude/CLAUDE.md`, the `.md` files under `.claude/rules`, and `CLAUDE.local.md`. When none of the `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md` files has content, Pi loads each directory's `AGENTS.md` and `.claude/AGENTS.md` instead. Pi does not load `AGENTS.override.md` from project directories.

To load `AGENTS.md` next to `CLAUDE.md`, set `pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles` to `claude-md-and-agents-md` in `~/.claude/settings.json`. The value `claude-md` turns `AGENTS.md` loading off.

Project and local memory follow pi's project trust decision. A stored "do not trust" decision, `--no-approve`, or `defaultProjectTrust: "never"` skips them. Without a decision, they load when the project has no trust-requiring resource and otherwise follow the trust prompt. Agent-directory context files do not require project trust.
