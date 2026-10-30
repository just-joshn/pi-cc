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

## Claude Code keybinding import

Pi-cc reads Claude Code's `keybindings.json` and runs it as its own dispatch layer in front of the default prompt editor, the way CC's dispatcher runs before its text input. The layer never edits pi's binding table. Pi's own `<agent-dir>/keybindings.json` keeps its normal pi meaning, with or without a CC file, and wins over the CC file (see Precedence).

CC's file is `$CLAUDE_CONFIG_DIR/keybindings.json`, or `~/.claude/keybindings.json` when the variable is unset or empty. A pi-dir `keybindings.json` written in CC's context-block format is read into the same layer after CC's file. Later declarations on the same sequence win. Only `bindings` is required, and unknown root fields such as `$schema` and `$docs` are ignored:

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

`Global` and `Chat` blocks apply in file order. Other contexts are ignored. Imported bindings use pi's defaults, not CC's default table: nothing is installed unless the file declares it.

### Dispatch

For each key in the default prompt editor, in this order:

1. Extension shortcuts, unchanged.
2. While the autocomplete menu is open, keys bound to pi's menu actions (`tui.select.*`, the completion key) go straight to pi. This matches CC's Autocomplete context, which is declared after Chat and wins on its default keys (escape, up, down, tab). Pi also keeps Enter and the page keys for the menu. A user Chat block that rebinds one of the menu's own keys would win in CC while the menu is open. Pi-cc keeps the menu.
3. A key matching an imported binding runs the mapped pi action and is consumed. An action may decline, which sends the key to step 4. `app:exit` declines on a non-empty prompt, as CC's handler does, so Ctrl+D still deletes forward there.
4. Everything else is handled by pi exactly as without a CC file.

An imported `null` removes that sequence from the CC layer. It does not touch pi's own binding on the key, so `"enter": null` still submits and `"ctrl+c": null` still clears. Moving a pi key is done in pi's own file.

A key can start a chord only when a longer imported binding exists. Its first stroke is consumed, so pi's action on that key stops firing while the chord is pending (importing CC's `ctrl+x ctrl+e` hides pi's Ctrl+X copy, and pi logs each hidden action to its debug log). A null chord never starts one. The pending prefix expires after three seconds. A mismatching next stroke, including Escape, is consumed and cancels. The prompt border shows a pending indicator, then a timeout notice.

### Precedence

Layering is pi defaults, then the CC file, then pi's own keybindings file. The CC layer runs first, so an imported key beats a pi default on the same key. A key that pi's own `<agent-dir>/keybindings.json` binds is the operator's choice and is not claimed by the CC layer: the CC binding on that key is dropped and pi's own handling runs. The same holds for a chord, so a CC chord whose first stroke the pi file binds is dropped whole and its prefix key keeps the pi action. Only keys the pi file explicitly binds count. Pi defaults the file restates also count. Keys are compared after CC aliases are normalized.

### Action mapping

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

`chat:thinkingToggle` and `app:interrupt` have no pi action with the same behavior, so they stay unmapped. A built-in pi action name as the value also works. The history pair maps to the cursor actions because CC's Up and Down move the cursor and only browse history at the first or last row, as pi's cursor actions do.

The importer accepts `control` for `ctrl`, `meta`/`opt`/`option` for `alt`, `cmd`/`command`/`win` for `super`, `esc` for `escape`, `return` for `enter`, `del` for `delete`, and arrow glyphs. A CC file that cannot be read at all produces a startup warning. Unsupported actions, contexts, and malformed sequences go to pi's debug log and create no bindings.

The layer applies only while the default prompt editor handles input. Selector dialogs, extension editors, and fullscreen viewport shortcuts keep their behavior. `getEffectiveConfig()` adds each imported binding's first stroke to its action for extension shortcut conflict checks. `getKeys()` and `getResolvedBindings()` return pi's own bindings.

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
