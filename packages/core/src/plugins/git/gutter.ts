import { gutter, GutterMarker, EditorView, Decoration, type DecorationSet } from '@codemirror/view';
import { StateField } from '@codemirror/state';
import type { EditorContribution } from '../editor';

/**
 * Git editor contributions (#203, ADR 0016).
 *
 * Headless CodeMirror extensions (no Svelte/DOM imports at module load;
 * `toDOM` guards for non-DOM test environments, pilot precedent in
 * `../editor.ts`). Registered through `host.registerEditorContribution` in
 * the Git plugin setup and composed by the host into its single CodeMirror
 * configuration with unchanged precedence.
 *
 * Current scope is wiring-only (no-op gutter + empty decoration field), so
 * gutter behavior is unchanged when enabled: no markers are produced, and
 * existing gutters (line numbers, fold) keep their order. Full line-level
 * change markers (added/modified/deleted per diff hunk) are future work
 * requiring per-file diff resolution; the contribution point is proven here.
 */

class GitGutterMarker extends GutterMarker {
	toDOM(): Node {
		if (typeof document !== 'undefined') {
			const span = document.createElement('span');
			span.className = 'cm-git-gutter-marker';
			span.textContent = '';
			return span;
		}
		return { nodeType: 1, textContent: '' } as any;
	}
}

export const gitGutterExtension = gutter({
	class: 'cm-git-gutter',
	// No-op: never produces markers today (wiring-only). Returning null keeps
	// existing gutter behavior pixel-identical when the plugin is enabled.
	lineMarker() {
		return null;
	}
});

export const gitDecorationField = StateField.define<DecorationSet>({
	create() {
		return Decoration.none;
	},
	update(decorations) {
		return decorations;
	},
	provide: (f) => EditorView.decorations.from(f)
});

export const GIT_GUTTER_CONTRIBUTION: EditorContribution = {
	id: 'git-gutter',
	type: 'gutter',
	extension: gitGutterExtension,
	priority: 0,
	description: 'Git gutter contribution (wiring-only: no markers yet)'
};

export const GIT_DECORATION_CONTRIBUTION: EditorContribution = {
	id: 'git-decoration',
	type: 'decoration',
	extension: gitDecorationField,
	priority: 0,
	description: 'Git decoration contribution (wiring-only: empty field)'
};

export function createGitEditorContributions(): EditorContribution[] {
	return [GIT_GUTTER_CONTRIBUTION, GIT_DECORATION_CONTRIBUTION];
}

// Re-export marker for future line-level work (unused today, keeps the
// wiring point discoverable without affecting behavior).
export { GitGutterMarker };
