import { Vim } from "@replit/codemirror-vim";

export interface WhichKeyNode {
	label: string;
	action?: string;
	children?: Record<string, WhichKeyNode>;
}

export const whichKeyStructure: Record<string, WhichKeyNode> = {
	"f": {
		label: "file",
		children: {
			"n": { label: "new-file", action: "file.new" },
			"o": { label: "open-file", action: "file.open" },
			"s": { label: "save-file", action: "file.save" },
			"a": { label: "save-as", action: "file.saveAs" },
		}
	},
	"e": {
		label: "edit",
		children: {
			"u": { label: "undo", action: "edit.undo" },
			"r": { label: "redo", action: "edit.redo" },
			"x": { label: "cut", action: "edit.cut" },
			"y": { label: "copy", action: "edit.copy" },
			"p": { label: "paste", action: "edit.paste" },
			"f": { label: "find", action: "edit.find" },
			"a": { label: "select-all", action: "edit.selectAll" },
			"l": { label: "change-language", action: "edit.changeLanguageMode" },
		}
	},
	"v": {
		label: "view",
		children: {
			"s": { label: "toggle-sidebar", action: "view.toggleSidebar" },
		}
	},
	"p": {
		label: "command-palette",
		action: "command-palette"
	}
};

let whichKeyRegistered = false;

function toCamelCase(str: string): string {
	return str.replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase());
}

export function registerWhichKeyCommands() {
	if (typeof window !== "undefined") {
		(window as any).WhichKeyVim = Vim;
	}
	try {
		console.log("Unmapping default and user Space maps...");
		Vim.unmap("<Space>", undefined as any);
		Vim.unmap("<Space>", "normal");
		Vim.unmap("<Space>", "visual");
		Vim.unmap(" ", undefined as any);
		Vim.unmap(" ", "normal");
		Vim.unmap(" ", "visual");
		console.log("Space unmapped successfully");
	} catch (e: any) {
		console.log("Vim.unmap failed:", e.message || e);
	}

	const register = (prefix: string, key: string, node: WhichKeyNode) => {
		const fullKey = `${prefix}${key}`;
		if (node.action) {
			const cleanAction = toCamelCase(node.action);
			const actionName = `Wk${cleanAction.charAt(0).toUpperCase()}${cleanAction.slice(1)}`;
			
			if (!whichKeyRegistered) {
				try {
					console.log("Defining Ex command:", actionName);
					Vim.defineEx(actionName, undefined, (cm) => {
						const view = cm.cm6;
						const appState = (view as any).appState;
						if (appState) {
							if (node.action === "command-palette") {
								appState.commandPalette.open = true;
							} else {
								appState.commands.execute(node.action);
							}
						}
					});
				} catch (e: any) {
					console.log("Vim.defineEx failed:", e.message || e);
				}
			}

			const vimKeys1 = fullKey.replace(' ', '<Space>');
			const vimKeys2 = vimKeys1.replaceAll('<Space>', ' ');
			try {
				console.log("Vim.map mapping key 1:", vimKeys1, "to", actionName);
				Vim.map(vimKeys1, `:${actionName}<CR>`, "normal");
				console.log("Vim.map mapping key 2:", vimKeys2, "to", actionName);
				Vim.map(vimKeys2, `:${actionName}<CR>`, "normal");
			} catch (e: any) {
				console.log("Vim.map failed:", e.message || e);
			}
		}

		if (node.children) {
			for (const childKey of Object.keys(node.children)) {
				register(fullKey, childKey, node.children[childKey]);
			}
		}
	};

	for (const key of Object.keys(whichKeyStructure)) {
		register("<Space>", key, whichKeyStructure[key]);
	}

	whichKeyRegistered = true;
}
