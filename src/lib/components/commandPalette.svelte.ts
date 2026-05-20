export interface CommandPaletteItem {
	id: string;
	label: string;
	shortcut?: string;
	action: () => void | Promise<void>;
	disabled?: boolean;
	icon?: any;
	iconClass?: string;
	meta?: string;
}

export class CommandPaletteState {
	open = $state(false);
	placeholder = $state("Type a command or search...");
	items = $state<CommandPaletteItem[] | null>(null);
	title = $state<string | null>(null);

	private history = $state<{
		items: CommandPaletteItem[] | null;
		placeholder: string;
		title: string | null;
	}[]>([]);

	openWith(options: {
		placeholder?: string;
		title?: string | null;
		items: CommandPaletteItem[] | null;
	}) {
		// Save current state to history
		this.history.push({
			items: this.items,
			placeholder: this.placeholder,
			title: this.title,
		});

		this.placeholder = options.placeholder ?? "Type a command or search...";
		this.title = options.title ?? null;
		this.items = options.items;
		this.open = true;
	}

	goBack() {
		if (this.history.length > 0) {
			const prev = this.history.pop()!;
			this.items = prev.items;
			this.placeholder = prev.placeholder;
			this.title = prev.title;
		} else {
			this.reset();
		}
	}

	reset() {
		this.open = false;
		this.items = null;
		this.placeholder = "Type a command or search...";
		this.title = null;
		this.history = [];
	}
}
