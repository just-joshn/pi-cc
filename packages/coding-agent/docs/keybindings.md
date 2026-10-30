# Keybindings Reference

Pi exposes named actions, such as `app.session.new`, that can be assigned keybindings. You can change default assignments or bind unassigned actions in Pi's [user configuration](configuration.md#agent-directory).

Run `/hotkeys` to see the active shortcuts for the main editor and application.

## Assign keybindings

Create `<agent-dir>/keybindings.json`. The agent directory defaults to `~/.pi/agent` and is described in [Agent directory](configuration.md#agent-directory).

Map each action identifier to one key or a list of keys:

```json
{
  "$schema": "https://pi.dev/schemas/keybindings.schema.json",
  "app.session.new": "ctrl+shift+n",
  "app.session.tree": ["ctrl+shift+t", "alt+shift+t"]
}
```

A configured value replaces the default for that action. Use an empty list to disable an action's keybindings:

```json
{
  "tui.altScreen.pageUp": []
}
```

After editing the file, run `/reload` to apply the changes to the active session.

## Key syntax

Write a key as `modifier+key`. Modifiers are `ctrl`, `shift`, `alt`, and `super`. You can combine modifiers. Valid keys are:

- **Letters:** `a-z`
- **Digits:** `0-9`
- **Special:** `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageUp`, `pageDown`, `up`, `down`, `left`, `right`
- **Function:** `f1`-`f12`
- **Symbols:** `` ` ``, `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `!`, `@`, `#`, `$`, `%`, `^`, `&`, `*`, `(`, `)`, `_`, `+`, `|`, `~`, `{`, `}`, `:`, `<`, `>`, `?`

Examples: `ctrl+shift+x`, `alt+ctrl+x`, `ctrl+shift+alt+x`, `super+k`, `ctrl+super+k`, and `ctrl+1`.

`super` bindings require a terminal that reports the modifier separately, typically through the Kitty keyboard protocol. They may not work in terminals without that support.

## Prompt chords and CC files

The default prompt editor accepts space-separated sequences in the same file. For example, `"app.model.select": "ctrl+k ctrl+s"` opens the model selector after both strokes. A chord prefix takes precedence over a single-key action on that prefix, including a single-key pi default: importing CC's default table makes Ctrl+X a chord prefix (`ctrl+x ctrl+e`), so pi's `app.message.copy` no longer fires on Ctrl+X. That matches CC, and pi logs each such hidden action to its debug log. The prefix expires after three seconds without running the single-key action. A mismatching next stroke is consumed, including Escape or another prefix. Escape cancels even if configured as a chord suffix. The prompt border shows a pending indicator, then a three-second timeout notice if no next key arrives.

CC's file is loaded from `$CLAUDE_CONFIG_DIR/keybindings.json`, or `~/.claude/keybindings.json` when the environment variable is unset or empty. Pi still loads `<agent-dir>/keybindings.json`. The layering is pi defaults, then CC's file, then pi's file, and later declarations win conflicts on the same sequence, the way CC's dispatcher takes the last declaration across active contexts. An import is a dispatched declaration: it replaces earlier imports and the sequence's application-level pi bindings, but pi's built-in input actions (`tui.editor.*`, `tui.input.*`) are the text-input layer CC's dispatched actions decline and fall through to, so an import never removes them. CC's `app:exit` on Ctrl+D keeps delete-forward working in a non-empty prompt, and restating a pi default collapses to that default rather than duplicating it. Autocomplete and selection actions (`tui.select.*`) and fullscreen viewport actions (`tui.altScreen.*`) also stay bound; while the autocomplete menu is open its keys take priority, matching CC's Autocomplete context. Native pi action assignments still replace that action's pi defaults. CC assignments on other sequences remain active. Importing CC's full default table is therefore not entirely behavior-neutral: it adds the `ctrl+x ctrl+e` chord, which takes over the Ctrl+X prefix as described above.

Either file can use CC's context-block format. Only `bindings` is required. Unknown root fields, including `$docs`, are ignored. Native action fields in a CC envelope are ignored rather than interpreted:

```json
{
	"bindings": [
		{
			"context": "Chat",
			"bindings": {
				"ctrl+k ctrl+s": "chat:modelPicker",
				"ctrl+l": null
			}
		}
	]
}
```

The default prompt editor applies `Global` and `Chat` blocks in file order. Later declarations replace earlier declarations for the same sequence. A `null` action unbinds that sequence's imported and application-level prompt bindings, but the keys CC's text input handles natively keep working: Return still submits, Up and Down still move the cursor and browse history at the ends, and editing keys still edit. Other contexts do not apply. Where two supported contexts declare the same sequence, the later declaration wins, and pi keeps its built-in autocomplete actions active so menu keys keep priority while the menu is open. Extension shortcut conflict checks use the effective prompt bindings, including the first stroke of a chord. Reserved actions block conflicting extension shortcuts. Other extension shortcut handlers keep their existing precedence.

Supported CC action mappings are:

| CC action | Pi action |
|---|---|
| `chat:submit` | `tui.input.submit` |
| `chat:cancel` | `app.interrupt` |
| `chat:newline` | `tui.input.newLine` |
| `chat:undo` | `tui.editor.undo` |
| `chat:imagePaste` | `app.clipboard.pasteImage` |
| `history:previous` | `tui.editor.cursorUp` |
| `history:next` | `tui.editor.cursorDown` |
| `chat:modelPicker` | `app.model.select` |
| `chat:externalEditor` | `app.editor.external` |
| `app:exit` | `app.exit` |

`chat:thinkingToggle` and `app:interrupt` have no pi action with the same behavior (CC's thinking toggle turns model thinking on and off, and CC's Ctrl+C aborts running work and exits on a second press when idle), so they stay unmapped. The `history` pair maps to the cursor actions because CC's Up and Down are built into its text input: they move the cursor and only browse history at the first or last row, which is what pi's cursor actions already do.

CC blocks also accept built-in pi action identifiers. Imported bindings use pi's defaults, not CC's default table. The importer accepts `control` for `ctrl`, `meta`/`opt`/`option` for `alt`, `cmd`/`command`/`win` for `super`, `esc` for `escape`, `return` for `enter`, `del` for `delete`, and arrow glyphs for their named directions. A file that cannot be read at all produces a startup warning through `KeybindingsManager.getImportDiagnostics()`. Unsupported actions, contexts, and malformed sequences are logged to pi's debug log and do not create bindings, matching how CC logs validation issues to its debug log.

Chords and context overrides apply only while the default prompt editor handles input. They do not change extension editors, selector dialogs, or fullscreen viewport shortcuts that handle input before the prompt. `getPromptKeys()` returns the prompt's effective sequences for key hints. `getEffectiveConfig()` returns single-stroke keys for prompt extension conflict checks, using a chord's first stroke. The lower-level `getKeys()`, `getResolvedBindings()`, and matching outside prompt dispatch retain the native single-key configuration.

## Actions

### Terminal UI

#### Cursor movement

| Keybinding id | Default | Description |
|---|---|---|
| `tui.editor.cursorUp` | `up` | Move cursor up, browsing older history at the top |
| `tui.editor.cursorDown` | `down` | Move cursor down, browsing newer history at the bottom |
| `tui.editor.historyPrevious` | None | Select the previous prompt history entry |
| `tui.editor.historyNext` | None | Select the next prompt history entry |
| `tui.editor.cursorLeft` | `left`, `ctrl+b` | Move cursor left |
| `tui.editor.cursorRight` | `right`, `ctrl+f` | Move cursor right |
| `tui.editor.cursorWordLeft` | `alt+left`, `ctrl+left`, `alt+b` | Move cursor word left |
| `tui.editor.cursorWordRight` | `alt+right`, `ctrl+right`, `alt+f` | Move cursor word right |
| `tui.editor.cursorLineStart` | `home`, `ctrl+a` | Move to line start |
| `tui.editor.cursorLineEnd` | `end`, `ctrl+e` | Move to line end |
| `tui.editor.jumpForward` | `ctrl+]` | Jump forward to character |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | Jump backward to character |
| `tui.editor.pageUp` | `pageUp`, `ctrl+pageUp` | Scroll up by page |
| `tui.editor.pageDown` | `pageDown`, `ctrl+pageDown` | Scroll down by page |

The dedicated history actions browse prompt history regardless of cursor position and take precedence over application actions using the same key.

#### Text editing

| Keybinding id | Default | Description |
|---|---|---|
| `tui.editor.deleteCharBackward` | `backspace` | Delete character backward |
| `tui.editor.deleteCharForward` | `delete`, `ctrl+d` | Delete character forward |
| `tui.editor.deleteWordBackward` | `ctrl+w`, `alt+backspace` | Delete word backward |
| `tui.editor.deleteWordForward` | `alt+d`, `alt+delete` | Delete word forward |
| `tui.editor.deleteToLineStart` | `ctrl+u` | Delete to line start |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | Delete to line end |
| `tui.editor.yank` | `ctrl+y` | Paste most recently deleted text |
| `tui.editor.yankPop` | `alt+y` | Cycle through deleted text after yank |
| `tui.editor.undo` | `ctrl+-` (`ctrl+z` on Windows; `alt+z` on WSL) | Undo last edit |

#### Input and selection

| Keybinding id | Default | Description |
|---|---|---|
| `tui.input.newLine` | `shift+enter`, `ctrl+j` | Insert new line |
| `tui.input.submit` | `enter` | Submit input |
| `tui.input.tab` | `tab` | Tab or autocomplete |
| `tui.input.copy` | `ctrl+c` | Copy selection |
| `tui.select.up` | `up` | Move selection up |
| `tui.select.down` | `down` | Move selection down |
| `tui.select.pageUp` | `pageUp` | Page up in list |
| `tui.select.pageDown` | `pageDown` | Page down in list |
| `tui.select.confirm` | `enter` | Confirm selection |
| `tui.select.cancel` | `escape`, `ctrl+c` | Cancel selection |

#### Fullscreen

In fullscreen mode, these actions control the transcript and take precedence over editor actions using the same key. While an overlay or a scrollable list such as autocomplete, `/settings`, or the model selector has focus, the scrolling and prompt-jump actions go to it instead of the transcript, so `tui.select.pageUp` and `tui.select.pageDown` move the list selection. Transcript search actions keep working.

| Keybinding id | Default | Description |
|---|---|---|
| `tui.altScreen.pageUp` | `pageUp` | Scroll the transcript up by one page |
| `tui.altScreen.pageDown` | `pageDown` | Scroll the transcript down by one page |
| `tui.altScreen.halfPageUp` | None | Scroll the transcript up by half a page |
| `tui.altScreen.halfPageDown` | None | Scroll the transcript down by half a page |
| `tui.altScreen.lineUp` | None | Scroll the transcript up by one line |
| `tui.altScreen.lineDown` | None | Scroll the transcript down by one line |
| `tui.altScreen.previousPrompt` | `ctrl+shift+up`, `ctrl+up` (`ctrl+up` only on Windows and WSL) | Jump to the previous marked message |
| `tui.altScreen.nextPrompt` | `ctrl+shift+down`, `ctrl+down` (`ctrl+down` only on Windows and WSL) | Jump to the next marked message |
| `tui.altScreen.search` | `ctrl+shift+f` (`ctrl+f` on Windows and WSL) | Search the rendered transcript |
| `tui.altScreen.searchNext` | `enter`, `ctrl+g` | Select the next search match while searching |
| `tui.altScreen.searchPrevious` | `shift+enter`, `ctrl+shift+g` | Select the previous search match while searching |
| `tui.altScreen.searchClose` | `escape` | Close transcript search |
| `tui.altScreen.top` | `ctrl+home` | Scroll to the beginning of the transcript |
| `tui.altScreen.bottom` | `ctrl+end` | Scroll to the transcript end and follow new output |

### Application

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.interrupt` | `escape` | Cancel / abort |
| `app.clear` | `ctrl+c` | Clear editor (first) / exit (second) |
| `app.exit` | `ctrl+d` | Exit (when editor empty) |
| `app.suspend` | `ctrl+z` (None on Windows) | Suspend to background |
| `app.editor.external` | `ctrl+g` | Open in external editor (`externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere) |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v` on Windows and WSL) | Paste files on macOS, images, or text from clipboard |

On native Windows, `app.suspend` has no default because Windows terminals do not support Unix job control. If you assign it manually, Pi shows a status message instead of suspending. WSL uses the normal `ctrl+z` and `fg` behavior.

### Sessions

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.session.new` | None | Start a new session (`/new`) |
| `app.session.tree` | None | Open session tree navigator (`/tree`) |
| `app.session.fork` | None | Fork current session (`/fork`) |
| `app.session.resume` | None | Open session resume picker (`/resume`) |
| `app.session.togglePath` | `ctrl+p` | Toggle path display |
| `app.session.toggleSort` | `ctrl+s` | Toggle sort mode |
| `app.session.toggleNamedFilter` | `ctrl+n` | Toggle named-only filter |
| `app.session.rename` | `ctrl+r` | Rename session |
| `app.session.delete` | `ctrl+d` | Delete session |
| `app.session.deleteNoninvasive` | `ctrl+backspace` | Delete session when query is empty |

### Models and Thinking

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.model.select` | `ctrl+l` | Open model selector |
| `app.model.cycleForward` | `ctrl+p` | Cycle to next model |
| `app.model.cycleBackward` | `shift+ctrl+p` (`alt+p` on Windows and WSL) | Cycle to previous model |
| `app.models.save` | `ctrl+s` | Save the selected default model or scoped model configuration to settings |
| `app.thinking.cycle` | `shift+tab` | Cycle thinking level |
| `app.thinking.save` | `ctrl+s` | Save current thinking level to settings |
| `app.thinking.toggle` | `ctrl+t` | Collapse or expand thinking blocks |

### Display and Message Queue

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.tools.expand` | `ctrl+o` | Collapse or expand tool output |
| `app.message.copy` | `ctrl+x` | Copy the selected message in `/tree`; in fullscreen mode, copy the active selection when `fullscreenCopyOnSelect` is `false`; otherwise copy the last assistant message. On OAuth sign-in screens, copy the sign-in URL |
| `app.message.followUp` | `alt+enter` (`ctrl+q` on Windows and WSL) | Queue follow-up message |
| `app.message.dequeue` | `alt+up` (`alt+q` on Windows and WSL) | Restore queued messages to editor |

### Tree Navigation

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.tree.foldOrUp` | `ctrl+left`, `alt+left` | Fold current branch segment, or jump to the previous segment start |
| `app.tree.unfoldOrDown` | `ctrl+right`, `alt+right` | Unfold current branch segment, or jump to the next segment start or branch end |
| `app.tree.editLabel` | `shift+l` | Edit the label on the selected tree node |
| `app.tree.toggleLabelTimestamp` | `shift+t` | Toggle label timestamps in the tree |
| `app.tree.filter.default` | `ctrl+d` | Set tree filter to default view |
| `app.tree.filter.noTools` | `ctrl+t` | Toggle tree filter that hides tool results |
| `app.tree.filter.userOnly` | `ctrl+u` | Toggle tree filter that shows only user messages |
| `app.tree.filter.labeledOnly` | `ctrl+l` | Toggle tree filter that shows only labeled entries |
| `app.tree.filter.all` | `ctrl+a` | Toggle tree filter that shows all entries |
| `app.tree.filter.cycleForward` | `ctrl+o` | Cycle tree filter forward |
| `app.tree.filter.cycleBackward` | `shift+ctrl+o` | Cycle tree filter backward |

### Scoped Models Selector

Used inside the scoped models selector (opened via `/scoped-models`).

| Keybinding id | Default | Description |
|--------|---------|-------------|
| `app.models.enableAll` | `ctrl+a` | Enable all models (or all matching the current search) |
| `app.models.clearAll` | `ctrl+x` | Clear all models (or all matching the current search) |
| `app.models.toggleProvider` | `ctrl+p` | Toggle all models for the current provider |
| `app.models.reorderUp` | `alt+up` | Move the selected model up in the cycle order |
| `app.models.reorderDown` | `alt+down` | Move the selected model down in the cycle order |
