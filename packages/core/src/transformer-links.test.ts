import "../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { HTMLExporter } from "./transformer/exporters/html";

describe("HTMLExporter Obsidian Wikilinks", () => {
	const exporter = new HTMLExporter();

	it("converts simple wikilink to HTML anchor with .html extension", async () => {
		const html = await exporter.export("Check out [[Three laws of motion]] for details.");
		expect(html).toContain('<a href="Three laws of motion.html">Three laws of motion</a>');
	});

	it("converts wikilink with alias to HTML anchor with custom text", async () => {
		const html = await exporter.export("Read [[Three laws of motion|the 3 laws]].");
		expect(html).toContain('<a href="Three laws of motion.html">the 3 laws</a>');
	});

	it("converts same-note heading link to anchor tag", async () => {
		const html = await exporter.export("Jump to [[#Section One]].");
		expect(html).toContain('<a href="#section-one">Section One</a>');
	});

	it("converts note and heading link with alias", async () => {
		const html = await exporter.export("See [[Physics#First Law|Newton's First Law]].");
		expect(html).toContain('<a href="Physics.html#first-law">Newton\'s First Law</a>');
	});

	it("converts embedded image ![[...]] to img tag", async () => {
		const html = await exporter.export("![[diagram.png]]");
		expect(html).toContain('<img src="diagram.png" alt="diagram.png"');
	});

	it("converts embedded image with alt text to img tag", async () => {
		const html = await exporter.export("![[diagram.png|Circuit Diagram]]");
		expect(html).toContain('<img src="diagram.png" alt="Circuit Diagram"');
	});

	it("emits heading ids matching wikilink fragment slugs", async () => {
		const html = await exporter.export("# Section One\n\nJump to [[#Section One]].");
		expect(html).toContain('<h1 id="section-one">Section One</h1>');
		expect(html).toContain('<a href="#section-one">Section One</a>');
	});

	it("rewrites uppercase markdown extensions to .html", async () => {
		const html = await exporter.export("See [[Note.MD]] for details.");
		expect(html).toContain('<a href="Note.html">Note.MD</a>');
	});

	it("escapes wikilink values to prevent markup injection", async () => {
		const html = await exporter.export('![[x" onerror="alert(1)]]');
		expect(html).not.toContain('onerror="alert(1)"');
		expect(html).toContain('x&quot; onerror=&quot;alert(1)');
	});

	it("escapes alias HTML in link text", async () => {
		const html = await exporter.export("See [[Note|<script>alert(1)</script>]].");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});
});
