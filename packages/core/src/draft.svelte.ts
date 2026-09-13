/**
 * Draft Carry-Forward kernel for a single Document.
 *
 * Owns the dirty/baseline/rebase decisions — whether in-memory content counts
 * as modified, which baseline it is diffed against, and how a freshly read
 * baseline merges with keystrokes typed while the read was in flight — while
 * storage I/O, permissions, and persistence scheduling stay with the caller.
 * In-process: no I/O here, so tests can drive it without a Storage stand-in.
 */
export class DocumentDraft {
	private savedBaseline = $state('');
	private baselinePending = $state(false);
	private onDirty: (() => void) | null;

	constructor(initialBaseline = '', onDirty: (() => void) | null = null) {
		this.savedBaseline = initialBaseline;
		this.onDirty = onDirty;
	}

	isModified(currentContent: string): boolean {
		return this.baselinePending || currentContent !== this.savedBaseline;
	}

	get baselineIsEmpty(): boolean {
		return this.savedBaseline === '';
	}

	notifyEdited(): void {
		this.onDirty?.();
	}

	markSaved(content: string): void {
		this.savedBaseline = content;
	}

	/**
	 * Fold a freshly read baseline in: keep in-flight keystrokes when modified,
	 * otherwise adopt the disk content. Returns the content the caller holds.
	 */
	applyLoaded(diskContent: string, currentContent: string): string {
		const keepEdits = this.isModified(currentContent);
		this.savedBaseline = diskContent;
		return keepEdits ? currentContent : diskContent;
	}

	/**
	 * Rebase the baseline onto on-disk content without touching in-memory
	 * edits (e.g. after a branch switch). Only the baseline moves.
	 */
	applyRebased(diskContent: string): void {
		this.savedBaseline = diskContent;
	}

	/**
	 * A restored draft has no trusted baseline until the disk read lands; stay
	 * dirty so an immediate flush cannot omit it. Stays dirty if the read
	 * fails — resolveBaseline is simply never called on that path.
	 */
	beginBaselineWait(): void {
		this.baselinePending = true;
	}

	resolveBaseline(savedContent: string): void {
		this.savedBaseline = savedContent;
		this.baselinePending = false;
	}
}
