import type { ButtonSize } from './ui/button/button.svelte';

export type HeaderSize = Extract<ButtonSize, 'xs' | 'sm' | 'default' | 'lg'>;

export const headerSizes = {
	xs: {
		height: 'h-7!',
		wide: 'xs' as ButtonSize,
		icon: 'icon-xs' as ButtonSize,
		trigger: 'px-1.5 py-0.5 text-[0.625rem] leading-tight',
	},
	sm: {
		height: 'h-8!',
		wide: 'sm' as ButtonSize,
		icon: 'icon-sm' as ButtonSize,
		trigger: 'px-2 py-1 text-xs leading-tight',
	},
	default: {
		height: 'h-9!',
		wide: 'default' as ButtonSize,
		icon: 'icon' as ButtonSize,
		trigger: 'px-2 py-1 text-xs leading-relaxed',
	},
	lg: {
		height: 'h-10!',
		wide: 'lg' as ButtonSize,
		icon: 'icon-lg' as ButtonSize,
		trigger: 'px-2.5 py-1.5 text-xs leading-relaxed',
	},
} as const satisfies Record<HeaderSize, { height: string; wide: ButtonSize; icon: ButtonSize; trigger: string }>;
