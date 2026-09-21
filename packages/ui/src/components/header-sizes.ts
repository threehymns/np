import type { ButtonSize } from './ui/button/button.svelte';

export type HeaderSize = Extract<ButtonSize, 'xs' | 'sm' | 'default' | 'lg'>;

export const headerSizes = {
	xs: {
		height: 'h-7!',
		wide: 'xs' as ButtonSize,
		icon: 'icon-xs' as ButtonSize,
		trigger: 'h-5 px-2 py-0 text-[0.625rem] leading-none',
	},
	sm: {
		height: 'h-8!',
		wide: 'sm' as ButtonSize,
		icon: 'icon-sm' as ButtonSize,
		trigger: 'h-6 px-2 py-0 text-xs leading-none',
	},
	default: {
		height: 'h-9!',
		wide: 'default' as ButtonSize,
		icon: 'icon' as ButtonSize,
		trigger: 'h-7 px-2 py-0 text-xs leading-none',
	},
	lg: {
		height: 'h-10!',
		wide: 'lg' as ButtonSize,
		icon: 'icon-lg' as ButtonSize,
		trigger: 'h-8 px-2.5 py-0 text-xs leading-none',
	},
} as const satisfies Record<HeaderSize, { height: string; wide: ButtonSize; icon: ButtonSize; trigger: string }>;