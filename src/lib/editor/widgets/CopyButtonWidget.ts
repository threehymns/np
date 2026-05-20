import { WidgetType } from "@codemirror/view";

export class CopyButtonWidget extends WidgetType {
	text: string;
	constructor(text: string) {
		super();
		this.text = text;
	}
	eq(other: CopyButtonWidget) {
		return other.text === this.text;
	}
	toDOM() {
		const btn = document.createElement("button");
		btn.className = "cm-copy-button";
		btn.setAttribute("aria-label", "Copy code");
		btn.title = "Copy code";
		btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="copy-icon"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
						<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="check-icon" style="display: none;"><polyline points="20 6 9 17 4 12"/></svg>`;

		btn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			navigator.clipboard.writeText(this.text).then(() => {
				const copyIcon = btn.querySelector(
					".copy-icon",
				) as HTMLElement;
				const checkIcon = btn.querySelector(
					".check-icon",
				) as HTMLElement;
				if (copyIcon && checkIcon) {
					copyIcon.style.display = "none";
					checkIcon.style.display = "block";
					btn.classList.add("copied");
					setTimeout(() => {
						copyIcon.style.display = "block";
						checkIcon.style.display = "none";
						btn.classList.remove("copied");
					}, 2000);
				}
			});
		};
		return btn;
	}
}
