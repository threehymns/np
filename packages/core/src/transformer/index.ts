import type { Exporter } from './types';
import { HTMLExporter } from './exporters/html';
import { PlainTextExporter } from './exporters/text';
import { sanitizeHtml, isSafeStyle, isSafeUrl } from './sanitize';

export { sanitizeHtml, isSafeStyle, isSafeUrl };

export class DocumentTransformer {
	private exporters = new Map<string, Exporter>();

	constructor() {
		this.register(new HTMLExporter());
		this.register(new PlainTextExporter());
	}

	register(exporter: Exporter) {
		this.exporters.set(exporter.format, exporter);
	}

	async transform(content: string, format: string): Promise<string> {
		const exporter = this.exporters.get(format);
		if (!exporter) {
			throw new Error(`Unsupported export format: ${format}`);
		}
		return await exporter.export(content);
	}

	getFormats() {
		return Array.from(this.exporters.keys());
	}

	getExporter(format: string) {
		return this.exporters.get(format);
	}
}

export const transformer = new DocumentTransformer();
