<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Reusable multibuffer (extracted from the Diff Viewer, #300).
	 *
	 * A stacked list of per-file sections with sticky headers, collapse, and
	 * scroll-past active-file sync. The Diff Viewer renders diffs through it;
	 * the diagnostics panel (#309), project search, and other diff views share
	 * this component. Section DOM ids follow `${idPrefix}file-` /
	 * `${idPrefix}header-` so hosts keep stable selectors and focus targets.
	 */

	export interface MultibufferSection {
		filepath: string;
		/**
		 * Stable identity across content updates AND scope changes (e.g. a
		 * diffed file switching between the staged, unstaged, and combined
		 * scopes). Re-keying a section destroys and rebuilds its content,
		 * so hosts must key by whatever identifies the file, not by the
		 * state it happens to be in.
		 */
		key: string;
	}

	interface Props {
		sections: MultibufferSection[];
		isCollapsed: (filepath: string) => boolean;
		idPrefix?: string;
		emptyState?: Snippet;
		header: Snippet<[string]>;
		content: Snippet<[string]>;
		onTopSectionVisible?: (filepath: string) => void;
		/**
		 * Called when focus enters a section, so the host can tell which file
		 * the user is working in. The Diff Viewer uses it to publish the save
		 * target for the focused file.
		 */
		onSectionFocusIn?: (filepath: string) => void;
	}

	let {
		sections,
		isCollapsed,
		idPrefix = '',
		emptyState,
		header,
		content,
		onTopSectionVisible,
		onSectionFocusIn
	}: Props = $props();

	let containerEl = $state<HTMLDivElement | null>(null);

	function handleScroll() {
		if (!containerEl) return;
		// Guard: only drive the active file if the container holds focus (mirroring Zed contains_focused)
		if (!containerEl.contains(document.activeElement)) return;

		const containerRect = containerEl.getBoundingClientRect();
		for (const section of sections) {
			const el = document.getElementById(`${idPrefix}file-${section.filepath}`);
			if (el) {
				const rect = el.getBoundingClientRect();
				if (rect.bottom > containerRect.top + 40 && rect.top <= containerRect.top + 80) {
					onTopSectionVisible?.(section.filepath);
					break;
				}
			}
		}
	}
</script>

<div
	bind:this={containerEl}
	onscroll={handleScroll}
	class="flex flex-col gap-2 flex-1 overflow-y-auto select-text bg-background"
>
	{#if sections.length === 0}
		{@render emptyState?.()}
	{:else}
		{#each sections as section (section.key)}
			{@const collapsed = isCollapsed(section.filepath)}
			<div
				class="flex flex-col bg-background"
				id="{idPrefix}file-{section.filepath}"
				onfocusin={() => onSectionFocusIn?.(section.filepath)}
			>
				<!-- File Header inside multibuffer -->
				<div class="sticky top-0 z-10 bg-background pt-2 pb-1 px-2">
					{@render header(section.filepath)}
				</div>

				<!-- Section Content (collapsible) -->
				{#if !collapsed}
					<div class="bg-muted/5 relative group border-t border-border/40">
						{@render content(section.filepath)}
					</div>
				{/if}
			</div>
		{/each}
	{/if}
</div>
