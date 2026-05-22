import { marked } from 'marked';
import type { Exporter } from '../types';

export class HTMLExporter implements Exporter {
	format = 'html';
	extension = '.html';

	async export(content: string): Promise<string> {
		const body = await marked.parse(content);
		
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
