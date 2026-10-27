<script lang="ts">
	import { cn } from '@np/core';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import MinusIcon from 'phosphor-svelte/lib/Minus';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { Button } from '../button/index.js';
	import * as InputGroup from '../input-group/index.js';

	type Props = {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		disabled?: boolean;
		class?: string;
		inputClass?: string;
		onValueChange?: (value: number) => void;
		decreaseLabel?: string;
		increaseLabel?: string;
	} & Omit<
		HTMLInputAttributes,
		'value' | 'min' | 'max' | 'step' | 'disabled' | 'type' | 'class' | 'onchange' | 'oninput' | 'files'
	>;

	let {
		value = $bindable(0),
		min = 0,
		max = Number.MAX_SAFE_INTEGER,
		step = 1,
		disabled = false,
		class: className,
		inputClass,
		onValueChange,
		decreaseLabel = 'Decrease',
		increaseLabel = 'Increase',
		...inputProps
	}: Props = $props();

	let typedLength = $state<number | null>(null);
	// Grow the middle with the number rather than reserving a fixed width.
	const inputWidth = $derived(Math.max(3, typedLength ?? String(value ?? '').length + 1));

	$effect(() => {
		// A value from the caller (stepper, reload) replaces any draft width.
		value;
		typedLength = null;
	});

	function clamp(next: number, fallback?: number): number {
		if (!Number.isFinite(next)) return fallback ?? min;
		return Math.min(max, Math.max(min, next));
	}

	function commit(next: number, fallback?: number): void {
		const bounded = clamp(next, fallback);
		if (bounded === value) {
			typedLength = null;
			return;
		}
		value = bounded;
		typedLength = null;
		onValueChange?.(bounded);
	}

	function nudge(direction: -1 | 1): void {
		commit((Number.isFinite(value) ? value : min) + direction * step);
	}

	function handleInput(event: Event): void {
		// Track the raw text so the middle grows while the user types, not only
		// after the value commits on blur.
		typedLength = (event.currentTarget as HTMLInputElement).value.length + 1;
	}

	function handleChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		if (input.value === '') {
			typedLength = null;
			return;
		}
		commit(input.valueAsNumber, value);
	}
</script>

<InputGroup.Root class={cn('h-7 w-fit overflow-hidden', className)}>
	<Button
		type="button"
		variant="ghost"
		class="h-full w-7 shrink-0 rounded-none border-0 border-r border-r-input p-0 text-muted-foreground hover:text-foreground"
		disabled={disabled || value <= min}
		aria-label={decreaseLabel}
		onclick={() => nudge(-1)}
	>
		<MinusIcon class="size-3" />
	</Button>

	<InputGroup.Input
		{...inputProps}
		type="number"
		{min}
		{max}
		{step}
		{disabled}
		value={value}
		oninput={handleInput}
		onchange={handleChange}
		style={`width: ${inputWidth}ch`}
		class={cn(
			'h-full flex-none px-0.5 text-center text-xs tabular-nums [appearance:textfield] [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
			inputClass
		)}
	/>

	<Button
		type="button"
		variant="ghost"
		class="h-full w-7 shrink-0 rounded-none border-0 border-l border-l-input p-0 text-muted-foreground hover:text-foreground"
		disabled={disabled || value >= max}
		aria-label={increaseLabel}
		onclick={() => nudge(1)}
	>
		<PlusIcon class="size-3" />
	</Button>
</InputGroup.Root>
