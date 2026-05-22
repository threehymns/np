export interface Exporter {
	format: string;
	extension: string;
	export(content: string): string | Promise<string>;
}
