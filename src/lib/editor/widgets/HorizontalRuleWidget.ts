import { WidgetType, EditorView } from "@codemirror/view";

export class HorizontalRuleWidget extends WidgetType {
	view: EditorView;
	from: number;
	to: number;
	constructor(view: EditorView, from: number, to: number) {
		super();
		this.view = view;
		this.from = from;
		this.to = to;
	}
	toDOM() {
		const wrapper = document.createElement("div");
		wrapper.className = "cm-horizontal-rule-wrapper";
		const hr = document.createElement("div");
		hr.className = "cm-horizontal-rule-inner";
		wrapper.appendChild(hr);

		wrapper.onclick = (e) => {
			e.preventDefault();
			this.view.focus();
			this.view.dispatch({
				selection: { anchor: this.from, head: this.to },
				scrollIntoView: true,
			});
		};

		return wrapper;
	}
}
