<script lang="ts">
	import type { Snippet } from 'svelte';
	import * as Command from './ui/command';
	import * as Popover from './ui/popover';
	import * as Tooltip from './ui/tooltip';
	import Button, { type ButtonSize } from './ui/button/button.svelte';
	import type { PickerRow } from './picker-row';

	/**
	 * A ghost button that opens a searchable list of rows in a popover.
	 *
	 * The shell — the trigger, its tooltip, the popover, the search field and
	 * the row list — lives here so that every picker opens, filters and reads
	 * the same way. What a row shows and what picking a row does stay with
	 * the picker that owns the list.
	 */
	let {
		open = $bindable(false),
		size = 'default',
		label,
		ariaLabel,
		tooltip,
		popupLabel,
		inputLabel,
		inputPlaceholder,
		emptyText,
		rows,
		onSelect,
		disabled = false,
		busy = false,
		flipInputOnTop = false,
		class: className = '',
		maxWidth = 'max-w-full',
		icon,
		row,
		footer
	}: {
		/** Whether the picker is open. */
		open?: boolean;
		/** Size of the trigger button. */
		size?: ButtonSize;
		/** Text on the trigger. */
		label: string;
		/** Accessible name of the trigger. */
		ariaLabel: string;
		/** Text in the trigger tooltip. Falls back to `label`. */
		tooltip?: string;
		/** Accessible name of the popover. Falls back to `ariaLabel`. */
		popupLabel?: string;
		/** Accessible name of the search field. */
		inputLabel: string;
		/** Placeholder of the search field. Falls back to `inputLabel`. */
		inputPlaceholder?: string;
		/** Text shown when no row matches the search. */
		emptyText: string;
		/** The rows the list shows. */
		rows: PickerRow[];
		/** Called when a row is picked. */
		onSelect?: (row: PickerRow) => void;
		/** Disables the trigger and every row. */
		disabled?: boolean;
		/** Marks the trigger as busy. */
		busy?: boolean;
		/** Moves the search field below the list when the popover opens upwards. */
		flipInputOnTop?: boolean;
		/** Extra classes for the trigger button. */
		class?: string;
		/** Maximum width of the trigger. */
		maxWidth?: string;
		/** Content of the leading trigger icon. */
		icon?: Snippet;
		/** Content of a row. */
		row?: Snippet<[PickerRow]>;
		/** Content below the list. */
		footer?: Snippet;
	} = $props();

	let trigger = $state<HTMLButtonElement | null>(null);
	let restoreFocus = false;
</script>

<Tooltip.Provider delayDuration={400}>
	<Popover.Root bind:open>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<span {...props} class="inline-flex min-w-0 {maxWidth}">
						<Popover.Trigger bind:ref={trigger}>
							{#snippet child({ props: popoverProps })}
								<Button
									{...popoverProps}
									type="button"
									disabled={disabled}
									aria-label={ariaLabel}
									aria-busy={busy || undefined}
									class="min-w-0 shrink {className}"
									variant="ghost"
									size={size}
								>
									{#if icon}{@render icon()}{/if}
									<span class="truncate min-w-0">{label}</span>
								</Button>
							{/snippet}
						</Popover.Trigger>
					</span>
				{/snippet}
			</Tooltip.Trigger>
			<!-- The tooltip is dropped while the picker is open: a tooltip that
				 stays open over the picker registers its own escape layer and
				swallows the Escape key the picker needs. The tooltip itself is
				not disabled, because a disabled tooltip stops reacting to the
				pointer leaving its trigger and would open late, over the header. -->
			{#if !open}
				<Tooltip.Content side="bottom" align="start" class="text-[10px] px-2 py-1 max-w-xs break-all">
					{tooltip ?? label}
				</Tooltip.Content>
			{/if}
		</Tooltip.Root>
		<Popover.Content
			trapFocus={false}
			onOpenAutoFocus={() => restoreFocus = false}
			onEscapeKeydown={() => restoreFocus = true}
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				if (restoreFocus) trigger?.focus();
			}}
			aria-label={popupLabel ?? ariaLabel}
			align="start"
			class="group/picker-pop w-80 max-w-[calc(100vw-1rem)] p-0 gap-0"
		>
			<Command.Root class={flipInputOnTop ? 'picker-flip-input group-data-[side=top]/picker-pop:flex-col-reverse' : ''}>
				<Command.Input aria-label={inputLabel} placeholder={inputPlaceholder ?? inputLabel} />
				<Command.List class="p-1">
					<Command.Empty>{emptyText}</Command.Empty>
					{#each rows as item (item.key ?? item.value)}
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<Command.Item
										{...props}
										data-slot="command-item"
										value={item.value}
										keywords={item.keywords}
										aria-current={item.current ? 'true' : undefined}
										disabled={disabled || item.disabled}
										onSelect={() => onSelect?.(item)}
										class="min-w-0 justify-between text-xs"
									>
										{@render row?.(item)}
									</Command.Item>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content side="right" align="center" class="text-[10px] px-2 py-1 max-w-xs break-all">
								{item.tooltip ?? item.label}
							</Tooltip.Content>
						</Tooltip.Root>
					{/each}
				</Command.List>
			</Command.Root>
			{#if footer}
				<div class="border-t p-1">
					{@render footer()}
				</div>
			{/if}
		</Popover.Content>
	</Popover.Root>
</Tooltip.Provider>

<style>
	/* The command item renders a check indicator that stays invisible unless
	   the row is checked. The pickers never check a row, so the indicator is
	   hidden instead of sitting in the layout as dead space after every row. */
	:global(.group\/picker-pop .cn-command-item-indicator) {
		display: none;
	}

	/* When the popover flips above the trigger the search field moves to the
	   bottom, closest to the trigger, and its padding flips with it. */
	:global(.group\/picker-pop[data-side='top'] .picker-flip-input [data-slot='command-input-wrapper']) {
		padding-top: 0;
		padding-bottom: 0.25rem;
	}
</style>
