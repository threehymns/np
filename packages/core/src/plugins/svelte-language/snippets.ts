import type { SnippetRecord } from '../completions';

/**
 * Svelte snippet pack.
 *
 * Pure data, registered by the Svelte Language Core Plugin's `setup` in the
 * same call that registers the language, so a pack can never outlive the
 * language it joins on.
 *
 * Triggers are word-shaped identifiers so the editor can match them with the
 * same word-character pattern the buffer-word source uses, and so the option
 * label is the exact trigger. Bodies are plain text with no placeholders and
 * no snippet variables: expanding tab stops is out of scope, so every body is
 * what lands in the document on accept.
 */
export const SVELTE_SNIPPETS: readonly SnippetRecord[] = [
	{
		id: 'svelte-reactive',
		language: 'svelte',
		trigger: 'reactive',
		body: '$: doubled = count * 2;',
		description: 'Reactive declaration ($:)'
	},
	{
		id: 'svelte-if',
		language: 'svelte',
		trigger: 'if',
		body: '{#if condition}\n\t\n{/if}',
		description: 'If block'
	},
	{
		id: 'svelte-each',
		language: 'svelte',
		trigger: 'each',
		body: '{#each items as item}\n\t\n{/each}',
		description: 'Each block'
	},
	{
		id: 'svelte-each-indexed',
		language: 'svelte',
		trigger: 'eachindexed',
		body: '{#each items as item, index}\n\t\n{/each}',
		description: 'Indexed each block'
	},
	{
		id: 'svelte-keyed',
		language: 'svelte',
		trigger: 'keyed',
		body: '{#key value}\n\t\n{/key}',
		description: 'Key block'
	},
	{
		id: 'svelte-await',
		language: 'svelte',
		trigger: 'await',
		body: '{#await promise}\n\t{:then value}\n\t\n{/await}',
		description: 'Await block'
	},
	{
		id: 'svelte-transition',
		language: 'svelte',
		trigger: 'transition',
		body: 'transition:fade={{ duration: 200 }}',
		description: 'Fade transition'
	},
	{
		id: 'svelte-onmount',
		language: 'svelte',
		trigger: 'onmount',
		body: 'onMount(() => {\n\t\n});',
		description: 'onMount lifecycle call'
	},
	{
		id: 'svelte-store',
		language: 'svelte',
		trigger: 'store',
		body: 'const count = writable(0);',
		description: 'Store creation (writable)'
	},
	{
		id: 'svelte-store-subscribe',
		language: 'svelte',
		trigger: 'storeauto',
		body: '{$store}',
		description: 'Auto-subscribed store value'
	}
];
