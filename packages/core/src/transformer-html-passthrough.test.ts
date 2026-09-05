import "../../../tests/contract/rune-setup";
import { describe, it, expect } from "bun:test";
import { HTMLExporter } from "./transformer/exporters/html";
import { sanitizeHtml } from "./transformer/sanitize";

describe("Obsidian HTML Passthrough & Sanitization", () => {
	const exporter = new HTMLExporter();

	describe("Obsidian HTML Formatting Passthrough", () => {
		it("renders HTML block with inline style and nested HTML tags", async () => {
			const md = `<div style="border:1px solid #888; padding:0.6em; border-radius:6px;">
  An <strong>HTML</strong> block with <em>inline</em> HTML.
</div>`;
			const html = await exporter.export(md);
			expect(html).toContain('<div style="border:1px solid #888; padding:0.6em; border-radius:6px;">');
			expect(html).toContain('<strong>HTML</strong>');
			expect(html).toContain('<em>inline</em>');
			expect(html).toContain('</div>');
		});

		it("does not parse Markdown inside HTML blocks", async () => {
			const md = `<div style="border:1px solid #888; padding:0.6em; border-radius:6px;">
  An <strong>HTML</strong> block with <em>inline</em> HTML. Markdown like **this** is NOT parsed inside HTML blocks.
</div>`;
			const html = await exporter.export(md);
			expect(html).toContain('Markdown like **this** is NOT parsed inside HTML blocks.');
			expect(html).not.toContain('<strong>this</strong>');
		});

		it("renders inline <br> tags", async () => {
			const md = "First line<br>Second line";
			const html = await exporter.export(md);
			expect(html).toContain("First line<br>Second line");
		});

		it("renders <u> underline via HTML tag", async () => {
			const md = "<u>Underline via HTML tag</u>";
			const html = await exporter.export(md);
			expect(html).toContain("<u>Underline via HTML tag</u>");
		});

		it("renders <sub> subscript and <sup> superscript via HTML tags", async () => {
			const md = "<sub>subscript</sub> and <sup>superscript</sup> via HTML tags.";
			const html = await exporter.export(md);
			expect(html).toContain("<sub>subscript</sub> and <sup>superscript</sup> via HTML tags.");
		});

		it("renders strikethrough <s>, <del>, and <ins> tags", async () => {
			const md = "<s>strikethrough</s> <del>deleted</del> <ins>inserted</ins>";
			const html = await exporter.export(md);
			expect(html).toContain("<s>strikethrough</s>");
			expect(html).toContain("<del>deleted</del>");
			expect(html).toContain("<ins>inserted</ins>");
		});

		it("preserves HTML comments", async () => {
			const md = "Before <!-- This is an HTML comment --> After";
			const html = await exporter.export(md);
			expect(html).toContain("<!-- This is an HTML comment -->");
		});

		it("renders HTML tables with full formatting", async () => {
			const md = `<table>
  <thead>
    <tr><th>Header 1</th><th>Header 2</th></tr>
  </thead>
  <tbody>
    <tr><td>Cell 1</td><td>Cell 2</td></tr>
  </tbody>
</table>`;
			const html = await exporter.export(md);
			expect(html).toContain("<table>");
			expect(html).toContain("<th>Header 1</th>");
			expect(html).toContain("<td>Cell 1</td>");
		});

		it("renders <details> and <summary> collapsible sections", async () => {
			const md = `<details>
  <summary>Click to expand</summary>
  <p>Hidden details content</p>
</details>`;
			const html = await exporter.export(md);
			expect(html).toContain("<details>");
			expect(html).toContain("<summary>Click to expand</summary>");
			expect(html).toContain("<p>Hidden details content</p>");
			expect(html).toContain("</details>");
		});

		it("allows safe <iframe> embeds for web content and media", async () => {
			const md = '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315" frameborder="0" allowfullscreen></iframe>';
			const html = await exporter.export(md);
			expect(html).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ"');
			expect(html).toContain('width="560"');
			expect(html).toContain('height="315"');
			expect(html).toContain('allowfullscreen');
		});

		it("allows <audio> and <video> elements with <source>", async () => {
			const md = `<video controls width="250">
  <source src="flower.webm" type="video/webm" />
  <source src="flower.mp4" type="video/mp4" />
</video>`;
			const html = await exporter.export(md);
			expect(html).toContain('<video controls width="250">');
			expect(html).toContain('<source src="flower.webm" type="video/webm" />');
			expect(html).toContain('</video>');
		});
	});

	describe("Obsidian HTML Security & Sanitization", () => {
		it("strips <script> tags and script bodies", async () => {
			const md = "Hello <script>alert('xss')</script> world";
			const html = await exporter.export(md);
			expect(html).not.toContain("<script>");
			expect(html).not.toContain("alert('xss')");
			expect(html).not.toContain("</script>");
			expect(html).toContain("Hello  world");
		});

		it("strips uppercase and parameterized <SCRIPT> tags", async () => {
			const md = '<SCRIPT TYPE="text/javascript" SRC="https://evil.com/payload.js"></SCRIPT>';
			const html = await exporter.export(md);
			expect(html).not.toContain("<SCRIPT");
			expect(html).not.toContain("https://evil.com/payload.js");
		});

		it("strips nested obfuscated script tags like <scr<script>ipt>", async () => {
			const md = "<scr<script>ipt>alert(1)</script>";
			const html = await exporter.export(md);
			expect(html).not.toContain("<script>");
			expect(html).not.toContain("alert(1)");
		});

		it("strips dangerous tags like <object>, <embed>, <applet>, <base>, <meta>, <link>", async () => {
			const md = '<object data="evil.swf"></object><embed src="evil.swf"><link rel="stylesheet" href="evil.css">';
			const html = await exporter.export(md);
			expect(html).not.toContain("<object");
			expect(html).not.toContain("<embed");
			expect(html).not.toContain("<link");
			expect(html).not.toContain("evil.swf");
		});

		it("strips inline event handlers (onerror, onload, onclick, onmouseover)", async () => {
			const md = '<img src="valid.png" onerror="alert(1)" onload="evil()\" />\n<div onclick="bad()" onmouseover="steal()">Text</div>';
			const html = await exporter.export(md);
			expect(html).not.toContain("onerror=");
			expect(html).not.toContain("onload=");
			expect(html).not.toContain("onclick=");
			expect(html).not.toContain("onmouseover=");
			expect(html).toContain('<img src="valid.png" />');
			expect(html).toContain('<div>Text</div>');
		});

		it("neutralizes javascript: URLs in links and iframes", async () => {
			const md = '<a href="javascript:alert(1)">Click</a>\n<iframe src="javascript:alert(2)"></iframe>';
			const html = await exporter.export(md);
			expect(html).not.toContain("javascript:alert(1)");
			expect(html).not.toContain("javascript:alert(2)");
			expect(html).toContain("<a>Click</a>");
		});

		it("neutralizes data:image/svg+xml with embedded scripts in iframes", async () => {
			const svgPayload = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
			const base64Svg = Buffer.from(svgPayload).toString("base64");
			const md = `<iframe src="data:image/svg+xml;base64,${base64Svg}"></iframe>`;
			const html = await exporter.export(md);
			expect(html).not.toContain("data:image/svg+xml;base64");
		});

		it("neutralizes dangerous CSS expressions in style attributes", async () => {
			const md = '<div style="background-image: url(javascript:alert(1)); color: blue;">Text</div>';
			const html = await exporter.export(md);
			expect(html).not.toContain("javascript:alert(1)");
			expect(html).not.toContain("style=");
		});

		it("allows safe styles while removing dangerous ones", async () => {
			const md = '<span style="color: red; font-size: 14px;">Red text</span>';
			const html = await exporter.export(md);
			expect(html).toContain('<span style="color: red; font-size: 14px;">Red text</span>');
		});
	});

	describe("sanitizeHtml standalone helper", () => {
		it("handles empty or null string gracefully", () => {
			expect(sanitizeHtml("")).toBe("");
			expect(sanitizeHtml(null as unknown as string)).toBe("");
		});

		it("preserves plain text without tags", () => {
			expect(sanitizeHtml("Just plain text with & and < and >")).toBe("Just plain text with & and < and >");
		});

		it("sanitizes unclosed <script> tags without deleting subsequent content", () => {
			const sanitized = sanitizeHtml("Text before <script>alert(1) remaining text");
			expect(sanitized).not.toContain("<script>");
			expect(sanitized).toContain("Text before");
			expect(sanitized).toContain("remaining text");
		});

		it("does not delete valid user document content following an unclosed script tag", () => {
			const md = "Heading\n\n<script src=\"bad.js\">\n\nHere is my important document text that must not be deleted.";
			const sanitized = sanitizeHtml(md);
			expect(sanitized).toContain("Here is my important document text that must not be deleted.");
		});
	});
});
