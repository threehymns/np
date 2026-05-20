import { WidgetType } from "@codemirror/view";

export class BulletWidget extends WidgetType {
	toDOM() {
		let span = document.createElement("span");
		span.textContent = "•";
		span.className = "md-bullet";
		return span;
	}
}
