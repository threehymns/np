import type { ZedIconTheme, ResolvedZedTheme, ZedThemeVariant } from "./zed-format";
import { resolveZedTheme } from "./zed-format";
import type { ResolvedIcon, FileIconProvider } from "../icons-types";

const COMMON_EXTENSION_FALLBACKS: Record<string, string> = {
	ts: 'typescript',
	js: 'javascript',
	html: 'html',
	jsx: 'react',
	tsx: 'react_ts',
	mjs: 'javascript',
	cjs: 'javascript',
};

const COMMON_LANGUAGE_FALLBACKS: Record<string, string> = {
	'typescript': 'typescript',
	'javascript': 'javascript',
	'html': 'html',
	'css': 'css',
	'python': 'python',
	'rust': 'rust',
	'go': 'go',
	'java': 'java',
	'ruby': 'ruby',
	'php': 'php',
	'sql': 'database',
	'json': 'json',
	'yaml': 'yaml',
	'toml': 'toml',
	'markdown': 'markdown',
	'svelte': 'svelte',
	'react': 'react',
	'vue': 'vue',
	'angular': 'angular',
	'docker': 'docker',
	'git': 'git',
};

const DIRECTORY_ALIASES: Record<string, string[]> = {
	'static': ['assets', 'asset', 'resource', 'resources'],
};

export class ManifestIconProvider implements FileIconProvider {
	private currentAppearance: 'light' | 'dark' = 'dark';
	private resolved: ResolvedZedTheme;
	private allVariants: ZedThemeVariant[];
	private baseUrl: string;
	private themeId: string;
	private themeName: string;

	constructor(id: string, name: string, theme: ZedIconTheme, baseUrl: string) {
		if (!theme || !Array.isArray(theme.themes) || theme.themes.length === 0) {
			throw new Error(`Invalid icon theme manifest for "${id}": no theme variants defined`);
		}
		this.themeId = id;
		this.themeName = name;
		this.allVariants = theme.themes;
		this.baseUrl = baseUrl;

		const defaultVariant = theme.themes.find(t => t.appearance === 'dark') ?? theme.themes[0];
		this.resolved = resolveZedTheme(id, name, defaultVariant, baseUrl);
	}

	setAppearance(appearance: 'light' | 'dark') {
		this.currentAppearance = appearance;
		const variant = this.allVariants.find(t => t.appearance === appearance)
			?? this.allVariants.find(t => t.appearance === 'dark')
			?? this.allVariants[0];
		if (variant) {
			this.resolved = resolveZedTheme(this.themeId, this.themeName, variant, this.baseUrl);
		}
	}

	get name(): string {
		return this.themeName;
	}

	get id(): string {
		return this.themeId;
	}

	resolveFileIcon(filename: string, context?: { language?: string }): ResolvedIcon | null {
		const lowerName = filename.toLowerCase();

		// 1. Exact match against file_stems
		let stemKey = this.resolved.fileStems[lowerName];
		if (stemKey) {
			const url = this.resolved.fileIcons[stemKey];
			if (url) return { type: 'url', value: url };
		}

		// 2. Hidden files: strip leading dot if it is a hidden file and check stems
		if (filename.startsWith('.') && filename.length > 1) {
			const strippedDot = lowerName.slice(1);
			stemKey = this.resolved.fileStems[strippedDot];
			if (stemKey) {
				const url = this.resolved.fileIcons[stemKey];
				if (url) return { type: 'url', value: url };
			}
		}

		// 3. Suffix / Multi-extension resolution via split-once loop on '.'
		const parts = lowerName.split('.');
		for (let i = 1; i < parts.length; i++) {
			const suffix = parts.slice(i).join('.');
			const suffixKey = this.resolved.fileSuffixes[suffix]
				?? COMMON_EXTENSION_FALLBACKS[suffix];
			if (suffixKey) {
				const url = this.resolved.fileIcons[suffixKey];
				if (url) return { type: 'url', value: url };
			}
		}

		// 4. Standard extension check
		const ext = parts.pop() || '';
		const extKey = this.resolved.fileSuffixes[ext] ?? COMMON_EXTENSION_FALLBACKS[ext];
		if (extKey) {
			const url = this.resolved.fileIcons[extKey];
			if (url) return { type: 'url', value: url };
		}

		// 5. Language Mode fallback check
		if (context?.language) {
			const lowerLang = context.language.toLowerCase();
			const langKey = COMMON_LANGUAGE_FALLBACKS[lowerLang] ?? lowerLang;

			// Define candidates to check for the file icon key in the theme
			const candidates = [
				langKey,
				`_f_${langKey}`
			];

			// Translate language ID to its canonical extension key as a backup
			const langExtMap: Record<string, string> = {
				'javascript': 'js',
				'typescript': 'ts',
				'markdown': 'md',
				'python': 'py',
				'rust': 'rs',
				'ruby': 'rb',
				'react': 'jsx',
			};

			const ext = langExtMap[lowerLang];
			if (ext) {
				candidates.push(ext);
				candidates.push(`_f_${ext}`);
			}

			for (const cand of candidates) {
				const url = this.resolved.fileIcons[cand];
				if (url) return { type: 'url', value: url };
			}
		}

		return null;
	}

	resolveFolderIcon(folderName: string, options?: { expanded?: boolean }): ResolvedIcon | null {
		const lowerName = folderName.toLowerCase();

		// 1. Try exact match
		let specific = this.resolved.namedDirectories[lowerName];
		if (specific) {
			const url = options?.expanded ? specific.expanded : specific.collapsed;
			if (url) return { type: 'url', value: url };
		}

		// 2. Try stripping leading dot
		if (lowerName.startsWith('.') && lowerName.length > 1) {
			const stripped = lowerName.slice(1);
			specific = this.resolved.namedDirectories[stripped];
			if (specific) {
				const url = options?.expanded ? specific.expanded : specific.collapsed;
				if (url) return { type: 'url', value: url };
			}
		}

		// 3. Try folder aliases
		const aliases = DIRECTORY_ALIASES[lowerName];
		if (aliases) {
			for (const alias of aliases) {
				specific = this.resolved.namedDirectories[alias];
				if (specific) {
					const url = options?.expanded ? specific.expanded : specific.collapsed;
					if (url) return { type: 'url', value: url };
				}
			}
		}

		return null;
	}

	getDefaultFileIcon(): ResolvedIcon | null {
		const url = this.resolved.fileIcons['file']
			?? this.resolved.fileIcons['default']
			?? this.resolved.fileIcons['fallback'];
		return url ? { type: 'url', value: url } : null;
	}

	getDefaultFolderIcon(options?: { expanded?: boolean }): ResolvedIcon | null {
		const url = options?.expanded
			? (this.resolved.directoryExpanded || this.resolved.directoryCollapsed)
			: this.resolved.directoryCollapsed;
		return url ? { type: 'url', value: url } : null;
	}

	// Legacy compatibility methods for Playwright tests
	getFileIcon(filename: string): string | null {
		const resolved = this.resolveFileIcon(filename) ?? this.getDefaultFileIcon();
		return resolved?.type === 'url' ? resolved.value : null;
	}
}
