<script lang="ts">
	import { DiffViewer } from '@np/ui';
	import { useAppState } from '@np/core';
	import { SCENES, emptyChange, freshChange, type PlaygroundChange } from '$lib/git-playground';

	const appState = useAppState();

	let selectedScene = $state(SCENES[0].name);
	let changes = $state<PlaygroundChange[]>(SCENES[0].changes.map(freshChange));

	function freshScene(changes: PlaygroundChange[]): PlaygroundChange[] {
		return changes.map(freshChange);
	}

	function loadScene(name: string) {
		selectedScene = name;
		const scene = SCENES.find((s) => s.name === name);
		changes = freshScene(scene ? scene.changes : []);
	}

	function reset() {
		const scene = SCENES.find((s) => s.name === selectedScene);
		changes = freshScene(scene ? scene.changes : []);
	}

	function recreate() {
		changes = changes.map(freshChange);
	}

	function addChange() {
		changes = [...changes, emptyChange()];
	}

	function removeChange(index: number) {
		changes = changes.filter((_, i) => i !== index);
	}

	let totalAdditions = $derived(changes.reduce((sum, c) => sum + (c.additions || 0), 0));
	let totalDeletions = $derived(changes.reduce((sum, c) => sum + (c.deletions || 0), 0));

	const currentScene = $derived(SCENES.find((s) => s.name === selectedScene));
</script>

<div class="flex h-full w-full overflow-hidden bg-background text-foreground text-xs">
	<aside class="w-[400px] shrink-0 h-full overflow-y-auto border-r border-border bg-muted/20 p-3 space-y-3 font-mono select-none">
		<div class="flex items-center justify-between gap-2">
			<h1 class="text-[11px] font-bold tracking-wide uppercase text-muted-foreground">Git Diff Playground</h1>
			<span class="text-[10px] text-muted-foreground tabular-nums">
				<span class="text-emerald-500">+{totalAdditions}</span>
				<span class="text-rose-500">-{totalDeletions}</span>
				· {changes.length} change{changes.length === 1 ? '' : 's'}
			</span>
		</div>

		<div class="grid grid-cols-[1fr_auto] gap-1.5">
			<select
				bind:value={selectedScene}
				onchange={(e) => loadScene(e.currentTarget.value)}
				class="bg-background border border-border rounded-md px-2 py-1.5 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-primary"
			>
				{#each SCENES as scene (scene.name)}
					<option value={scene.name}>{scene.name}</option>
				{/each}
			</select>
			<div class="flex gap-1.5">
				<button
					type="button"
					onclick={reset}
					title="Reload the selected scene as fresh GitChange objects"
					class="px-2 py-1 rounded-md border border-border bg-background hover:bg-muted transition-colors cursor-pointer text-[11px]"
				>
					Reset
				</button>
				<button
					type="button"
					onclick={recreate}
					title="Rebuild the array with brand new GitChange identities but identical data - simulates repo.refresh() replacing the changes array"
					class="px-2 py-1 rounded-md border border-border bg-background hover:bg-muted transition-colors cursor-pointer text-[11px]"
				>
					Recreate objects
				</button>
			</div>
		</div>

		{#if currentScene}
			<p class="text-[10px] leading-relaxed text-muted-foreground border-l-2 border-primary/40 pl-2">{currentScene.description}</p>
		{/if}

		<div class="border-t border-border/60 pt-2">
			<div class="flex items-center justify-between mb-1.5">
				<span class="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Changes</span>
				<button
					type="button"
					onclick={addChange}
					class="px-1.5 py-0.5 rounded border border-border bg-background hover:bg-muted transition-colors cursor-pointer text-[10px]"
				>
					+ Add
				</button>
			</div>

			<div class="space-y-2">
				{#each changes as change, i (change._id)}
					<div class="rounded-md border border-border/70 bg-background p-2 space-y-1.5">
						<div class="flex items-center gap-1.5">
							<input
								type="checkbox"
								bind:checked={change.staged}
								title="Staged"
								class="size-3 shrink-0 accent-primary"
							/>
							<input
								bind:value={change.filepath}
								spellcheck="false"
								class="flex-1 min-w-0 bg-muted/40 border border-border rounded px-1.5 py-0.5 text-[10.5px] outline-none focus-visible:ring-1 focus-visible:ring-primary"
							/>
							<select
								bind:value={change.status}
								title="Status"
								class="bg-muted/40 border border-border rounded px-1 py-0.5 text-[10px] outline-none focus-visible:ring-1 focus-visible:ring-primary"
							>
								<option value="M">M</option>
								<option value="A">A</option>
								<option value="D">D</option>
								<option value="U">U</option>
							</select>
							<button
								type="button"
								onclick={() => removeChange(i)}
								title="Remove this change"
								class="size-4 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
							>
								×
							</button>
						</div>
						<div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
							<label class="flex items-center gap-0.5 text-emerald-500">+<input type="number" min="0" bind:value={change.additions} class="w-12 bg-muted/40 border border-border rounded px-1 py-0.5 tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-primary" /></label>
							<label class="flex items-center gap-0.5 text-rose-500">-<input type="number" min="0" bind:value={change.deletions} class="w-12 bg-muted/40 border border-border rounded px-1 py-0.5 tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-primary" /></label>
							<input
								bind:value={change.diff}
								placeholder="diff (optional)"
								spellcheck="false"
								class="flex-1 min-w-0 bg-muted/40 border border-border rounded px-1.5 py-0.5 text-[10px] outline-none focus-visible:ring-1 focus-visible:ring-primary placeholder:text-muted-foreground/60"
							/>
						</div>
						<textarea
							bind:value={change.originalContent}
							placeholder="originalContent (HEAD)"
							spellcheck="false"
							class="w-full h-32 resize-y bg-background border border-rose-500/30 rounded-md px-1.5 py-1 text-[10.5px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-rose-500/60 placeholder:text-muted-foreground/60"
						></textarea>
						<textarea
							bind:value={change.modifiedContent}
							placeholder="modifiedContent (worktree)"
							spellcheck="false"
							class="w-full h-32 resize-y bg-background border border-emerald-500/30 rounded-md px-1.5 py-1 text-[10.5px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60 placeholder:text-muted-foreground/60"
						></textarea>
					</div>
				{/each}
			</div>
		</div>

		<div class="border-t border-border/60 pt-2 space-y-1 text-[10px] leading-relaxed text-muted-foreground">
			<button
				type="button"
				onclick={() => (appState.prefs.wordWrap = !appState.prefs.wordWrap)}
				class="flex items-center gap-2 w-full text-left px-2 py-1 rounded-md border border-border bg-background hover:bg-muted transition-colors cursor-pointer"
			>
				<span class="font-bold uppercase tracking-wide text-[9px]">Word wrap</span>
				<span class="ml-auto tabular-nums">{appState.prefs.wordWrap ? 'ON' : 'OFF'}</span>
			</button>
			<p>1. Edit the <span class="text-emerald-500">worktree</span> (or <span class="text-rose-500">HEAD</span>) text and watch the diff view refresh.</p>
			<p>2. Toggle <b>staged</b> to flip between staged/combined views.</p>
			<p>3. <b>Recreate objects</b> replaces the array with new identities (same data) — the path fixed by the CodeMirror diff-extension commit.</p>
			<p>4. <b>Reset</b> restores the selected scene. Purely local; nothing touches the real repo.</p>
		</div>
	</aside>

	<main class="flex-1 min-w-0 h-full">
		<DiffViewer changes={changes} />
	</main>
</div>