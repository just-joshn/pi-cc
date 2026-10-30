/** The `/usage` view: Claude Code's session usage text in a dialog that closes with Esc and writes nothing to the transcript. */

import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

export class UsageDialogComponent extends Container {
	private readonly onClose: () => void;

	constructor(report: string, onClose: () => void) {
		super();
		this.onClose = onClose;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Session"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(report, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "Esc to cancel"), 1, 0));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		if (getKeybindings().matches(keyData, "tui.select.cancel")) this.onClose();
	}
}
