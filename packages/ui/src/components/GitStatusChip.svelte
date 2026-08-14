<script lang="ts">
	let { status }: { status: 'M' | 'A' | 'D' | 'S' | 'U' } = $props();

	const statusConfig = {
		M: { label: 'Modified', class: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
		A: { label: 'Added', class: 'bg-primary/10 text-primary' },
		U: { label: 'Untracked', class: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
		D: { label: 'Deleted', class: 'bg-destructive/10 text-destructive' },
		S: { label: 'Staged', class: 'bg-primary/10 text-primary' },
	} as const;

	let config = $derived(statusConfig[status] || statusConfig.M);
</script>

<span
	class="text-[9px] font-bold px-1 rounded font-mono scale-90 w-4 flex justify-center shrink-0 {config.class}"
	title={config.label}
	aria-label={config.label}
>{status}</span>
