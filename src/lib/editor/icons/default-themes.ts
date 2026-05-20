export interface IconPackManifest {
	id: string;
	name: string;
	type: 'file' | 'product';
	baseUrl: string;
	fileNames?: Record<string, string>;
	fileExtensions?: Record<string, string>;
	languageIds?: Record<string, string>;
	defaultIcon?: string;
}

export const vscodeIconsManifest: IconPackManifest = {
	id: 'vscode',
	name: 'VS Code Icons',
	type: 'file',
	baseUrl: 'https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons@v2.18.0/icons/',
	defaultIcon: 'default_file.svg',
	fileNames: {
		'package.json': 'file_type_npm.svg',
		'tsconfig.json': 'file_type_tsconfig.svg',
		'vite.config.ts': 'file_type_vite.svg',
		'svelte.config.js': 'file_type_svelte.svg',
		'bun.lock': 'file_type_bun.svg',
		'bun.lockb': 'file_type_bun.svg'
	},
	fileExtensions: {
		'ts': 'file_type_typescript.svg',
		'js': 'file_type_js.svg',
		'tsx': 'file_type_typescript_react.svg',
		'jsx': 'file_type_reactjs.svg',
		'svelte': 'file_type_svelte.svg',
		'html': 'file_type_html.svg',
		'css': 'file_type_css.svg',
		'json': 'file_type_json.svg',
		'yaml': 'file_type_yaml.svg',
		'yml': 'file_type_yaml.svg',
		'toml': 'file_type_toml.svg',
		'md': 'file_type_markdown.svg',
		'txt': 'file_type_text.svg',
		'sql': 'file_type_sql.svg',
		'py': 'file_type_python.svg',
		'rs': 'file_type_rust.svg',
		'go': 'file_type_go.svg',
		'cpp': 'file_type_cpp.svg',
		'c': 'file_type_c.svg',
		'java': 'file_type_java.svg',
		'rb': 'file_type_ruby.svg'
	},
	languageIds: {
		'typescript': 'file_type_typescript.svg',
		'javascript': 'file_type_js.svg',
		'svelte': 'file_type_svelte.svg',
		'markdown': 'file_type_markdown.svg',
		'json': 'file_type_json.svg',
		'yaml': 'file_type_yaml.svg',
		'toml': 'file_type_toml.svg',
		'sql': 'file_type_sql.svg',
		'python': 'file_type_python.svg',
		'rust': 'file_type_rust.svg',
		'go': 'file_type_go.svg',
		'cpp': 'file_type_cpp.svg',
		'c': 'file_type_c.svg',
		'java': 'file_type_java.svg',
		'ruby': 'file_type_ruby.svg'
	}
};

export const materialIconsManifest: IconPackManifest = {
	id: 'material',
	name: 'Material Icons',
	type: 'file',
	baseUrl: 'https://cdn.jsdelivr.net/gh/material-extensions/vscode-material-icon-theme@v5.17.0/icons/',
	defaultIcon: 'file.svg',
	fileNames: {
		'package.json': 'npm.svg',
		'tsconfig.json': 'tsconfig.svg',
		'vite.config.ts': 'vite.svg',
		'svelte.config.js': 'svelte.svg',
		'bun.lock': 'bun.svg',
		'bun.lockb': 'bun.svg'
	},
	fileExtensions: {
		'ts': 'typescript.svg',
		'js': 'javascript.svg',
		'tsx': 'react_ts.svg',
		'jsx': 'react.svg',
		'svelte': 'svelte.svg',
		'html': 'html.svg',
		'css': 'css.svg',
		'json': 'json.svg',
		'yaml': 'yaml.svg',
		'yml': 'yaml.svg',
		'toml': 'toml.svg',
		'md': 'markdown.svg',
		'txt': 'document.svg',
		'sql': 'database.svg',
		'py': 'python.svg',
		'rs': 'rust.svg',
		'go': 'go.svg',
		'cpp': 'cpp.svg',
		'c': 'c.svg',
		'java': 'java.svg',
		'rb': 'ruby.svg'
	},
	languageIds: {
		'typescript': 'typescript.svg',
		'javascript': 'javascript.svg',
		'svelte': 'svelte.svg',
		'markdown': 'markdown.svg',
		'json': 'json.svg',
		'yaml': 'yaml.svg',
		'toml': 'toml.svg',
		'sql': 'database.svg',
		'python': 'python.svg',
		'rust': 'rust.svg',
		'go': 'go.svg',
		'cpp': 'cpp.svg',
		'c': 'c.svg',
		'java': 'java.svg',
		'ruby': 'ruby.svg'
	}
};

export const catppuccinIconsManifest: IconPackManifest = {
	id: 'catppuccin',
	name: 'Catppuccin Icons',
	type: 'file',
	baseUrl: 'https://cdn.jsdelivr.net/gh/catppuccin/vscode-icons@v1.26.0/icons/',
	defaultIcon: 'file.svg',
	fileNames: {
		'package.json': 'npm.svg',
		'tsconfig.json': 'tsconfig.svg',
		'vite.config.ts': 'vite.svg',
		'svelte.config.js': 'svelte.svg',
		'bun.lock': 'bun.svg',
		'bun.lockb': 'bun.svg'
	},
	fileExtensions: {
		'ts': 'typescript.svg',
		'js': 'javascript.svg',
		'tsx': 'react_ts.svg',
		'jsx': 'react.svg',
		'svelte': 'svelte.svg',
		'html': 'html.svg',
		'css': 'css.svg',
		'json': 'json.svg',
		'yaml': 'yaml.svg',
		'yml': 'yaml.svg',
		'toml': 'toml.svg',
		'md': 'markdown.svg',
		'txt': 'txt.svg',
		'sql': 'sql.svg',
		'py': 'python.svg',
		'rs': 'rust.svg',
		'go': 'go.svg',
		'cpp': 'cpp.svg',
		'c': 'c.svg',
		'java': 'java.svg',
		'rb': 'ruby.svg'
	},
	languageIds: {
		'typescript': 'typescript.svg',
		'javascript': 'javascript.svg',
		'svelte': 'svelte.svg',
		'markdown': 'markdown.svg',
		'json': 'json.svg',
		'yaml': 'yaml.svg',
		'toml': 'toml.svg',
		'sql': 'sql.svg',
		'python': 'python.svg',
		'rust': 'rust.svg',
		'go': 'go.svg',
		'cpp': 'cpp.svg',
		'c': 'c.svg',
		'java': 'java.svg',
		'ruby': 'ruby.svg'
	}
};
