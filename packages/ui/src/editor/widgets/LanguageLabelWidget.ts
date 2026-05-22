import { WidgetType } from "@codemirror/view";

export class LanguageLabelWidget extends WidgetType {
	lang: string;
	constructor(lang: string) {
		super();
		this.lang = lang;
	}
	eq(other: LanguageLabelWidget) {
		return other.lang === this.lang;
	}
	toDOM() {
		const span = document.createElement("span");
		span.className = "cm-language-label";
		span.textContent = this.lang;
		return span;
	}
}
