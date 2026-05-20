export class SelectionState {
	line = $state(1);
	column = $state(1);
	charCount = $state(0);
	wordCount = $state(0);

	update(line: number, column: number, charCount: number, wordCount: number) {
		this.line = line;
		this.column = column;
		this.charCount = charCount;
		this.wordCount = wordCount;
	}

	reset() {
		this.line = 1;
		this.column = 1;
		this.charCount = 0;
		this.wordCount = 0;
	}
}

export const selectionState = new SelectionState();
