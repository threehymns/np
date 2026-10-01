<script lang="ts">
	import type { SettingNamespaceSchema, SettingScope } from '@np/core';
	import GeneratedSettingControl from './GeneratedSettingControl.svelte';

	let {
		schema,
		scope = 'user',
		title,
		description
	}: {
		schema: SettingNamespaceSchema;
		scope?: SettingScope;
		title?: string;
		description?: string;
	} = $props();

	const sectionTitle = $derived(title || schema.title || schema.namespace);
	const sectionDescription = $derived(description || schema.description);
	const propertyEntries = $derived(Object.entries(schema.properties || {}));
</script>

<div class="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-200">
	<header class="space-y-1">
		<div class="flex items-center gap-2">
			<h3 class="text-xl font-bold tracking-tight text-foreground">{sectionTitle}</h3>
			<span class="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground font-mono">
				{schema.namespace}
			</span>
		</div>
		{#if sectionDescription}
			<p class="text-sm text-muted-foreground">{sectionDescription}</p>
		{/if}
	</header>

	<div class="space-y-4">
		{#if propertyEntries.length === 0}
			<div class="p-8 text-center border rounded-xl bg-card/30 text-muted-foreground text-sm">
				No configurable settings in this namespace.
			</div>
		{:else}
			{#each propertyEntries as [keyName, propSchema] (keyName)}
				<GeneratedSettingControl
					namespace={schema.namespace}
					{keyName}
					schema={propSchema}
					{scope}
				/>
			{/each}
		{/if}
	</div>
</div>
