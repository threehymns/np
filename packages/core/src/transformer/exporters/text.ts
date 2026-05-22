import type { Exporter } from '../types';

export class PlainTextExporter implements Exporter {
	format = 'text';
	extension = '.txt';

	export(content: string): string {
		// Basic markdown stripping (shallow for now)
		return content
			.replace(/^#+\s+/gm, '') // headings
			.replace(/\*\*(.*?)\*\*/g, '$1') // bold
			.replace(/\*(.*?)\*/g, '$1') // italic
			.replace(/!\[.*?\]\(.*?\)/g, '') // images
			.replace(/\[(.*?)\]\(.*?\)/g, '$1') // links
			.replace(/`{3,}[\s\S]*?`{3,}/g, (match) => match.replace(/`{3,}/g, '')) // code blocks
			.replace(/`(.*?)`/g, '$1'); // inline code
	}
}
