import type { ZedIconTheme } from "./zed-format";

export interface BuiltinZedThemeConfig {
	id: string;
	name: string;
	repoUrl: string;
	themePath: string;
	iconBaseUrl: string;
}

export const builtinFileThemes: BuiltinZedThemeConfig[] = [
	{
		id: 'material',
		name: 'Material Icons',
		repoUrl: 'https://github.com/zed-extensions/material-icon-theme',
		themePath: 'icon_themes/material-icon-theme.json',
		iconBaseUrl: 'https://cdn.jsdelivr.net/gh/zed-extensions/material-icon-theme@main/',
	},
	{
		id: 'catppuccin',
		name: 'Catppuccin Icons',
		repoUrl: 'https://github.com/catppuccin/zed-icons',
		themePath: 'icon_themes/catppuccin-icons.json',
		iconBaseUrl: 'https://cdn.jsdelivr.net/gh/catppuccin/zed-icons@main/',
	},
	{
		id: 'vscode',
		name: 'VS Code Icons',
		repoUrl: 'https://github.com/vscode-icons/vscode-icons-zed',
		themePath: 'icon_themes/vsicons-icon-theme-zed.json',
		iconBaseUrl: 'https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons-zed@master/',
	},
];

export async function fetchZedTheme(url: string): Promise<ZedIconTheme | null> {
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		return response.json() as Promise<ZedIconTheme>;
	} catch {
		return null;
	}
}
