<script lang="ts">
	let { status }: { status: 'M' | 'A' | 'D' | 'S' | 'U' } = $props();
</script>

{#if status === 'M'}
	<span class="text-[9px] font-bold px-1 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-mono scale-90 w-4 flex justify-center shrink-0">M</span>
{:else if status === 'A'}
	<span class="text-[9px] font-bold px-1 rounded bg-primary/10 text-primary font-mono scale-90 w-4 flex justify-center shrink-0">A</span>
{:else if status === 'U'}
	<span class="text-[9px] font-bold px-1 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-mono scale-90 w-4 flex justify-center shrink-0">U</span>
{:else if status === 'D'}
	<span class="text-[9px] font-bold px-1 rounded bg-destructive/10 text-destructive font-mono scale-90 w-4 flex justify-center shrink-0">D</span>
{:else if status === 'S'}
	<span class="text-[9px] font-bold px-1 rounded bg-primary/10 text-primary font-mono scale-90 w-4 flex justify-center shrink-0">S</span>
{/if}
