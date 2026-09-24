<script lang="ts">
	let { message = 'Hello from Hello Plugin' }: { message?: string } = $props();
</script>

<div class="flex flex-col gap-2 p-4" data-testid="hello-panel">
	<span class="text-sm font-semibold text-foreground">{message}</span>
	<p class="text-xs text-muted-foreground">
		This panel is contributed by the Hello Core Plugin through the generic sidebar-panel
		registry.
	</p>
</div>
