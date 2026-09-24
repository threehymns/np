<script lang="ts">
	import { useAppState } from '@np/core';
	import type { SettingPropertySchema, SettingScope } from '@np/core';
	import { Switch } from '../ui/switch/index.js';
	import { Label } from '../ui/label/index.js';
	import { ArrowCounterClockwise, Warning, Check } from 'phosphor-svelte';
	import { cn } from '@np/core';

	let {
		namespace,
		keyName,
		schema,
		scope = 'user'
	}: {
		namespace: string;
		keyName: string;
		schema: SettingPropertySchema;
		scope?: SettingScope;
	} = $props();

	const appState = useAppState();

	// Reactive version bumped by SettingsManager on every mutation, so edits
	// refresh resolved/hasOverride/diagnostics without remounting the modal.
	const settingsVersion = $derived(appState.prefs.settingsVersion);

	const resolved = $derived.by(() => {
		settingsVersion;
		return appState.prefs.settings.resolve(namespace, keyName);
	});
	const hasOverride = $derived.by(() => {
		settingsVersion;
		return appState.prefs.hasWorkspaceOverride
			? (scope === 'workspace' ? appState.prefs.hasWorkspaceOverride(namespace, keyName) : appState.prefs.settings.hasOverride(namespace, keyName, 'user'))
			: appState.prefs.settings.hasOverride(namespace, keyName, scope);
	});

	const isScopeAllowed = $derived(!schema.scope || schema.scope.includes(scope));

	const diagnostics = $derived.by(() => {
		settingsVersion;
		return appState.prefs.settings.getDiagnostics(scope).filter(
			(d) => d.namespace === namespace && d.key === keyName
		);
	});

	const effectiveValue = $derived(resolved.value);
	const provenance = $derived(resolved.provenance);

	let jsonDraft = $state('');
	let jsonError = $state<string | null>(null);

	$effect(() => {
		if (schema.type === 'object' || schema.type === 'array' || schema.control === 'json') {
			try {
				jsonDraft = JSON.stringify(effectiveValue, null, 2);
				jsonError = null;
			} catch {
				jsonDraft = String(effectiveValue);
			}
		}
	});

	function updateValue(val: any) {
		if (!isScopeAllowed) return;
		try {
			appState.prefs.set(namespace, keyName, val, scope);
		} catch (err: any) {
			console.error(`Failed to set ${namespace}.${keyName}:`, err);
		}
	}

	function resetOverride() {
		try {
			appState.prefs.unset(namespace, keyName, scope);
		} catch (err: any) {
			console.error(`Failed to unset ${namespace}.${keyName}:`, err);
		}
	}

	function handleJsonBlur() {
		if (!isScopeAllowed) return;
		try {
			const parsed = JSON.parse(jsonDraft);
			jsonError = null;
			updateValue(parsed);
		} catch (err: any) {
			jsonError = err.message || 'Invalid JSON syntax';
		}
	}
</script>

<div
	class={cn(
		"p-4 rounded-xl border bg-card/50 transition-all space-y-3",
		hasOverride ? "border-primary/40 bg-accent/10" : "border-border/60",
		!isScopeAllowed && "opacity-60"
	)}
	data-testid={`setting-control-${namespace}-${keyName}`}
>
	<div class="flex items-start justify-between gap-4">
		<div class="space-y-1 flex-1 min-w-0">
			<div class="flex items-center gap-2 flex-wrap">
				<Label class="text-sm font-semibold text-foreground">
					{schema.label || schema.title || keyName}
				</Label>
				<code class="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-muted/60 font-mono">
					{namespace}.{keyName}
				</code>

				<!-- Provenance & Scope badges -->
				<span
					class={cn(
						"text-[10px] font-medium px-2 py-0.5 rounded-full inline-flex items-center gap-1",
						provenance === 'workspace' && "bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/20",
						provenance === 'user' && "bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/20",
						provenance === 'default' && "bg-muted text-muted-foreground border border-border/40"
					)}
				>
					{provenance === 'workspace' ? 'Workspace' : provenance === 'user' ? 'User' : 'Default'}
					{#if scope === 'workspace' && provenance !== 'workspace'}
						<span class="opacity-70 font-normal">(inherited)</span>
					{/if}
				</span>

				{#if !isScopeAllowed}
					<span class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20">
						User scope only
					</span>
				{/if}
			</div>

			{#if schema.description}
				<p class="text-xs text-muted-foreground leading-relaxed">{schema.description}</p>
			{/if}
		</div>

		<!-- Revert / Reset Button -->
		{#if hasOverride && isScopeAllowed}
			<button
				onclick={resetOverride}
				title={`Reset ${scope} override to inherit`}
				class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md border border-border/80 hover:bg-accent transition-colors"
			>
				<ArrowCounterClockwise size={12} />
				<span>Reset</span>
			</button>
		{/if}
	</div>

	<!-- Diagnostics warning if any -->
	{#if diagnostics.length > 0}
		{#each diagnostics as diag}
			<div class="flex items-center gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs">
				<Warning size={14} class="shrink-0" />
				<span>{diag.message}</span>
			</div>
		{/each}
	{/if}

	<!-- Control Input Elements -->
	<div class="pt-1">
		{#if !isScopeAllowed}
			<div class="text-xs text-muted-foreground italic py-1">
				This setting cannot be overridden at workspace level. Edit in User settings.
			</div>
		{:else if schema.type === 'boolean' || schema.control === 'toggle' || schema.control === 'checkbox'}
			<div class="flex items-center justify-between">
				<span class="text-xs text-muted-foreground">
					{effectiveValue ? 'Enabled' : 'Disabled'}
				</span>
				<Switch
					checked={!!effectiveValue}
					onCheckedChange={(checked) => updateValue(checked)}
				/>
			</div>

		{:else if schema.enum && schema.enum.length > 0 || schema.control === 'select'}
			<div class="max-w-xs">
				<select
					class="w-full text-xs rounded-lg border border-border bg-background px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary shadow-sm"
					value={effectiveValue ?? schema.default}
					onchange={(e) => {
						const val = (e.target as HTMLSelectElement).value;
						const converted = schema.type === 'number' ? Number(val) : val;
						updateValue(converted);
					}}
				>
					{#if schema.enum}
						{#each schema.enum as opt}
							<option value={opt}>{opt}</option>
						{/each}
					{:else}
						<option value={effectiveValue}>{effectiveValue}</option>
					{/if}
				</select>
			</div>

		{:else if schema.type === 'number' || schema.control === 'slider' || schema.control === 'number'}
			<div class="flex items-center gap-4 max-w-sm">
				{#if schema.minimum !== undefined && schema.maximum !== undefined || schema.control === 'slider'}
					<input
						type="range"
						min={schema.minimum ?? 0}
						max={schema.maximum ?? 100}
						step={schema.step ?? 1}
						value={effectiveValue ?? schema.default ?? 0}
						oninput={(e) => updateValue(Number((e.target as HTMLInputElement).value))}
						class="w-full accent-primary cursor-pointer"
					/>
				{/if}
				<input
					type="number"
					min={schema.minimum}
					max={schema.maximum}
					step={schema.step ?? 1}
					value={effectiveValue ?? schema.default ?? 0}
					onchange={(e) => updateValue(Number((e.target as HTMLInputElement).value))}
					class="w-24 text-xs rounded-lg border border-border bg-background px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
				/>
			</div>

		{:else if schema.control === 'color'}
			<div class="flex items-center gap-3">
				<input
					type="color"
					value={typeof effectiveValue === 'string' && effectiveValue.startsWith('#') ? effectiveValue : '#000000'}
					onchange={(e) => updateValue((e.target as HTMLInputElement).value)}
					class="w-8 h-8 rounded cursor-pointer border border-border bg-transparent p-0"
				/>
				<input
					type="text"
					value={effectiveValue ?? ''}
					onchange={(e) => updateValue((e.target as HTMLInputElement).value)}
					placeholder={schema.default ?? ''}
					class="w-36 text-xs rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
				/>
			</div>

		{:else if schema.type === 'object' || schema.type === 'array' || schema.control === 'json'}
			<div class="space-y-1.5">
				<textarea
					bind:value={jsonDraft}
					onblur={handleJsonBlur}
					rows={4}
					class={cn(
						"w-full text-xs font-mono rounded-lg border bg-background p-2.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary leading-normal",
						jsonError ? "border-destructive focus:ring-destructive" : "border-border"
					)}
					placeholder="{'{}'}"
				></textarea>
				{#if jsonError}
					<p class="text-[11px] text-destructive">{jsonError}</p>
				{/if}
			</div>

		{:else}
			<div class="max-w-sm">
				<input
					type="text"
					value={effectiveValue ?? ''}
					placeholder={schema.default !== undefined ? String(schema.default) : ''}
					onchange={(e) => updateValue((e.target as HTMLInputElement).value)}
					class="w-full text-xs rounded-lg border border-border bg-background px-3 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary shadow-sm"
				/>
			</div>
		{/if}
	</div>
</div>
