export interface ZedIconTheme {
	$schema?: string;
	name: string;
	author?: string;
	themes: ZedThemeVariant[];
}

export interface ZedThemeVariant {
	name: string;
	appearance: 'light' | 'dark';
	file_stems?: Record<string, string>;
	file_suffixes?: Record<string, string>;
	file_icons?: Record<string, { path: string }>;
	directory_icons?: { collapsed: string; expanded: string };
	named_directory_icons?: Record<string, { collapsed: string; expanded: string }>;
	chevron_icons?: { collapsed: string; expanded: string };
}

export interface ResolvedZedTheme {
	id: string;
	name: string;
	baseUrl: string;
	fileIcons: Record<string, string>;
	fileStems: Record<string, string>;
	fileSuffixes: Record<string, string>;
	directoryCollapsed: string | null;
	directoryExpanded: string | null;
	namedDirectories: Record<string, { collapsed: string; expanded: string }>;
}

export function resolveZedTheme(id: string, name: string, theme: ZedThemeVariant, baseUrl: string): ResolvedZedTheme {
	const fileIcons: Record<string, string> = {};
	for (const [key, icon] of Object.entries(theme.file_icons ?? {})) {
		fileIcons[key] = resolvePath(icon.path, baseUrl);
	}

	const namedDirectories: Record<string, { collapsed: string; expanded: string }> = {};
	for (const [folder, icons] of Object.entries(theme.named_directory_icons ?? {})) {
		namedDirectories[folder] = {
			collapsed: resolvePath(icons.collapsed, baseUrl),
			expanded: resolvePath(icons.expanded, baseUrl),
		};
	}

	return {
		id,
		name,
		baseUrl,
		fileIcons,
		fileStems: theme.file_stems ?? {},
		fileSuffixes: theme.file_suffixes ?? {},
		directoryCollapsed: theme.directory_icons ? resolvePath(theme.directory_icons.collapsed, baseUrl) : null,
		directoryExpanded: theme.directory_icons ? resolvePath(theme.directory_icons.expanded, baseUrl) : null,
		namedDirectories,
	};
}

function resolvePath(iconPath: string, baseUrl: string): string {
	if (iconPath.startsWith('http://') || iconPath.startsWith('https://')) {
		return iconPath;
	}

	const url = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
	const basePath = url.pathname.replace(/\/[^/]*$/, '');

	const parts = basePath.split('/').filter(Boolean);
	const segments = iconPath.split('/');
	for (const seg of segments) {
		if (seg === '..') {
			parts.pop();
		} else if (seg !== '.' && seg !== '') {
			parts.push(seg);
		}
	}

	url.pathname = '/' + parts.join('/');
	return url.toString();
}
