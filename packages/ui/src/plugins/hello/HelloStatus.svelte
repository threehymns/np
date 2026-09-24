<script lang="ts">
	let { message = 'Hello Status' }: { message?: string } = $props();
</script>

<span class="text-[11px] text-muted-foreground" data-testid="hello-status">{message}</span>
