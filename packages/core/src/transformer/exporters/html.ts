import { Marked } from 'marked';
import type { Exporter } from '../types';
import { parseInternalLink } from '../../links';

const wikilinkExtension = {
	name: 'wikilink',
	level: 'inline' as const,
	start(src: string) {
		const match = src.match(/!?\[\[/);
		return match ? match.index : -1;
	},
	tokenizer(src: string) {
		const rule = /^(!)?\[\[([^\]\n]+)\]\]/;
		const match = rule.exec(src);
		if (match) {
			const isEmbed = Boolean(match[1]);
			const inner = match[2];
			return {
				type: 'wikilink',
				raw: match[0],
				isEmbed,
				inner,
			};
		}
	},
	renderer(token: any) {
		const parsed = parseInternalLink((token.isEmbed ? '!' : '') + '[[' + token.inner + ']]');
		if (parsed.isEmbed) {
			const alt = parsed.alias || parsed.path;
			return `<img src="${parsed.path}" alt="${alt}" />`;
		}

		let href = '';
		if (parsed.path) {
			const hasExt = /\.[a-zA-Z0-9]+$/.test(parsed.path);
			href = hasExt ? parsed.path.replace(/\.md$/, '.html') : `${parsed.path}.html`;
		}
		if (parsed.subpath) {
			const slug = parsed.subpath.value
				.toLowerCase()
				.replace(/[^\w\s-]/g, '')
				.replace(/\s+/g, '-');
			href = href ? `${href}#${slug}` : `#${slug}`;
		}
		const displayText =
			parsed.alias ||
			(parsed.path
				? parsed.subpath
					? `${parsed.path}#${parsed.subpath.value}`
					: parsed.path
				: parsed.subpath?.value || '');

		return `<a href="${href}">${displayText}</a>`;
	},
};

export class HTMLExporter implements Exporter {
	format = 'html';
	extension = '.html';
	private markedInstance: Marked;

	constructor() {
		this.markedInstance = new Marked();
		this.markedInstance.use({
			extensions: [wikilinkExtension],
		});
	}

	async export(content: string): Promise<string> {
		const body = await this.markedInstance.parse(content);

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Exported Document</title>
	<style>
		:root {
			--bg: #ffffff;
			--text: #1a1a1a;
			--muted: #666666;
			--code-bg: #f5f5f5;
			--border: #eeeeee;
		}
		@media (prefers-color-scheme: dark) {
			:root {
				--bg: #121212;
				--text: #e0e0e0;
				--muted: #a0a0a0;
				--code-bg: #1e1e1e;
				--border: #333333;
			}
		}
		body {
			font-family: 'Inter', system-ui, -apple-system, sans-serif;
			line-height: 1.7;
			color: var(--text);
			background: var(--bg);
			max-width: 720px;
			margin: 4rem auto;
			padding: 0 2rem;
			transition: background 0.3s, color 0.3s;
		}
		h1, h2, h3, h4 { margin-top: 2.5rem; line-height: 1.3; }
		a { color: #0070f3; text-decoration: none; }
		a:hover { text-decoration: underline; }
		pre {
			background: var(--code-bg);
			padding: 1.25rem;
			border-radius: 8px;
			overflow-x: auto;
			border: 1px solid var(--border);
		}
		code {
			font-family: 'JetBrains Mono', ui-monospace, monospace;
			background: var(--code-bg);
			padding: 0.2rem 0.4rem;
			border-radius: 4px;
			font-size: 0.9em;
		}
		pre code { background: transparent; padding: 0; font-size: 14px; }
		img { max-width: 100%; height: auto; border-radius: 8px; }
		blockquote {
			border-left: 4px solid #0070f3;
			padding: 0.5rem 0 0.5rem 1.5rem;
			color: var(--muted);
			margin: 2rem 0;
			font-style: italic;
		}
		table {
			border-collapse: collapse;
			width: 100%;
			margin: 2rem 0;
		}
		th, td {
			border: 1px solid var(--border);
			padding: 0.75rem;
			text-align: left;
		}
		th { background: var(--code-bg); font-weight: 600; }
	</style>
</head>
<body>
	${body}
</body>
</html>`;
	}
}
