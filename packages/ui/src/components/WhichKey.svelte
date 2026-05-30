<script lang="ts">
	import { useAppState, keystrokesEqual } from "@np/core";

	const appState = useAppState();
	const keymaps = appState.keymaps;

	// Helper to format keystroke path for header (e.g. "Leader ➔ file")
	const pathTitle = $derived.by(() => {
		const parts = ["Leader"];
		const pathAccum: any[] = [];
		
		// Skip the first leader key for the title path usually, 
		// but let's show the sequence starting from the second key
		for (let i = 1; i < keymaps.keyBuffer.length; i++) {
			const k = keymaps.keyBuffer[i];
			const nextPath = [...keymaps.keyBuffer.slice(0, i), k];
			
			// Try to find a common category or label for this prefix
			const active = keymaps.getActiveBindings();
			const matching = active.filter(b => {
				if (b.sequence.length <= i + 1) return false;
				for (let j = 0; j <= i; j++) {
					if (!keystrokesEqual(b.sequence[j], nextPath[j])) return false;
				}
				return true;
			});

			if (matching.length > 0) {
				const categories = new Set(matching.map(b => appState.commands.get(b.commandId)?.category).filter(Boolean));
				if (categories.size === 1) {
					parts.push(Array.from(categories)[0]!.toLowerCase());
				} else {
					parts.push(k.key === ' ' ? 'space' : k.key);
				}
			} else {
				parts.push(k.key === ' ' ? 'space' : k.key);
			}
		}
		return parts.join(" ➔ ");
	});

	// Derive choices from active bindings starting with current keyBuffer
	const choices = $derived.by(() => {
		const L = keymaps.keyBuffer.length;
		if (L === 0) return [];
		
		const active = keymaps.getActiveBindings();
		
		// Find matching bindings
		const matching = active.filter(b => {
			if (b.sequence.length <= L) return false;
			for (let i = 0; i < L; i++) {
				if (!keystrokesEqual(b.sequence[i], keymaps.keyBuffer[i])) return false;
			}
			return true;
		});

		// Group matching bindings by the next keystroke key
		const grouped = new Map<string, { bindings: typeof matching, isGroup: boolean }>();

		for (const binding of matching) {
			const nextKeystroke = binding.sequence[L];
			const nextKey = nextKeystroke.key === ' ' ? 'space' : nextKeystroke.key;
			const isGroup = binding.sequence.length > L + 1;
			
			if (!grouped.has(nextKey)) {
				grouped.set(nextKey, { bindings: [binding], isGroup });
			} else {
				const entry = grouped.get(nextKey)!;
				entry.bindings.push(binding);
				if (isGroup) entry.isGroup = true;
			}
		}

		// Map to standard Choice list
		return Array.from(grouped.entries()).map(([key, { bindings, isGroup }]) => {
			const firstBinding = bindings[0];
			const nextKeystroke = firstBinding.sequence[L];
			let label = '';
			
			if (isGroup) {
				// Derive group label from common category
				const categories = new Set(bindings.map(b => appState.commands.get(b.commandId)?.category).filter(Boolean));
				if (categories.size === 1) {
					label = Array.from(categories)[0]!.toLowerCase();
				} else {
					label = key;
				}
			} else {
				label = appState.commands.get(firstBinding.commandId)?.label || firstBinding.commandId;
				if (label.startsWith('Preferences: ')) {
					label = label.replace('Preferences: ', '');
				}
			}

			return {
				key: nextKeystroke.key === ' ' ? 'space' : nextKeystroke.key,
				nextKeystroke,
				label,
				isGroup,
				commandId: firstBinding.commandId
			};
		}).sort((a, b) => a.key.localeCompare(b.key));
	});

	function handleChoiceClick(choice: typeof choices[0]) {
		if (choice.isGroup) {
			keymaps.keyBuffer = [...keymaps.keyBuffer, choice.nextKeystroke];
		} else {
			appState.commands.execute(choice.commandId);
			keymaps.keyBuffer = [];
		}
	}
</script>

{#if choices.length > 0}
	<div class="whichkey-panel animate-in fade-in slide-in-from-bottom duration-150">
		<div class="whichkey-header">
			<span class="whichkey-title">{pathTitle}</span>
			<span class="whichkey-hint">Press <kbd class="px-1.5 py-0.5 text-[10px] rounded">Esc</kbd> to cancel</span>
		</div>
		<div class="whichkey-grid">
			{#each choices as choice}
				<button
					type="button"
					class="whichkey-item"
					onclick={() => handleChoiceClick(choice)}
				>
					<kbd class="whichkey-kbd">{choice.key}</kbd>
					<span class="whichkey-label">
						{#if choice.isGroup}
							+{choice.label}
						{:else}
							{choice.label}
						{/if}
					</span>
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
	.whichkey-panel {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		background-color: var(--sidebar);
		border-top: 1px solid var(--sidebar-border);
		padding: 0.75rem 1rem 1rem 1rem;
		z-index: 100;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		box-shadow: 0 -4px 12px -2px rgba(0, 0, 0, 0.12);
	}

	.whichkey-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		border-bottom: 1px solid var(--sidebar-border);
		padding-bottom: 0.35rem;
	}

	.whichkey-title {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--sidebar-foreground);
		font-family: var(--font-sans);
	}

	.whichkey-hint {
		font-size: 0.7rem;
		color: var(--sidebar-foreground);
		opacity: 0.8;
	}

	.whichkey-hint kbd {
		background-color: var(--sidebar-accent);
		border: 1px solid var(--sidebar-border);
		color: var(--sidebar-foreground);
	}

	.whichkey-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}

	@media (min-width: 640px) {
		.whichkey-grid {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}

	@media (min-width: 1024px) {
		.whichkey-grid {
			grid-template-columns: repeat(6, minmax(0, 1fr));
		}
	}

	.whichkey-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius, 0.375rem);
		padding: 0.35rem 0.5rem;
		cursor: pointer;
		text-align: left;
		transition: all 0.15s ease;
		outline: none;
	}

	.whichkey-item:hover {
		background-color: var(--sidebar-accent);
		border-color: var(--sidebar-border);
	}

	.whichkey-item:hover .whichkey-label {
		color: var(--sidebar-accent-foreground);
	}

	.whichkey-item:hover .whichkey-kbd {
		background-color: var(--sidebar);
	}

	.whichkey-item:focus-visible {
		background-color: var(--sidebar-accent);
		border-color: var(--sidebar-primary);
	}

	.whichkey-item:focus-visible .whichkey-label {
		color: var(--sidebar-accent-foreground);
	}

	.whichkey-item:focus-visible .whichkey-kbd {
		background-color: var(--sidebar);
	}

	.whichkey-kbd {
		font-family: var(--font-mono, monospace);
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--sidebar-primary);
		background-color: var(--sidebar-accent);
		border: 1px solid var(--sidebar-border);
		padding: 0.15rem 0.4rem;
		border-radius: 0.25rem;
		min-width: 1.5rem;
		text-align: center;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
		transition: background-color 0.15s ease;
	}

	.whichkey-label {
		font-size: 0.75rem;
		color: var(--sidebar-foreground);
		font-family: var(--font-sans);
		transition: color 0.15s ease;
	}
</style>
