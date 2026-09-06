import { describe, it, expect } from "bun:test";
import { parseResizeToken, parseSizeToken } from "./links";

describe("parseSizeToken (bare token)", () => {
	it("parses bare widths", () => {
		expect(parseSizeToken("300")).toEqual({ width: 300, height: null });
		expect(parseSizeToken("400")).toEqual({ width: 400, height: null });
	});

	it("parses optional WxH", () => {
		expect(parseSizeToken("300x200")).toEqual({ width: 300, height: 200 });
	});

	it("trims surrounding whitespace", () => {
		expect(parseSizeToken("  300  ")).toEqual({ width: 300, height: null });
	});

	it("rejects missing tokens", () => {
		expect(parseSizeToken("")).toBeNull();
		expect(parseSizeToken("   ")).toBeNull();
	});

	it("rejects non-numeric and suffixed tokens", () => {
		expect(parseSizeToken("Custom Text")).toBeNull();
		expect(parseSizeToken("abc")).toBeNull();
		expect(parseSizeToken("300px")).toBeNull();
		expect(parseSizeToken("300%")).toBeNull();
		expect(parseSizeToken("30.5")).toBeNull();
		expect(parseSizeToken("-300")).toBeNull();
		expect(parseSizeToken("+300")).toBeNull();
	});

	it("rejects malformed WxH", () => {
		expect(parseSizeToken("300x")).toBeNull();
		expect(parseSizeToken("x200")).toBeNull();
		expect(parseSizeToken("300x200x100")).toBeNull();
		expect(parseSizeToken("300 x 200")).toBeNull();
		expect(parseSizeToken("300X200")).toBeNull();
	});

	it("rejects non-positive dimensions", () => {
		expect(parseSizeToken("0")).toBeNull();
		expect(parseSizeToken("0x10")).toBeNull();
		expect(parseSizeToken("10x0")).toBeNull();
	});
});

describe("parseResizeToken (wikilink-embed targets)", () => {
	it("parses photo.png|300", () => {
		expect(parseResizeToken("photo.png|300")).toEqual({
			base: "photo.png",
			size: { width: 300, height: null },
		});
	});

	it("parses photo.png|400", () => {
		expect(parseResizeToken("photo.png|400")).toEqual({
			base: "photo.png",
			size: { width: 400, height: null },
		});
	});

	it("parses WxH photo.png|300x200", () => {
		expect(parseResizeToken("photo.png|300x200")).toEqual({
			base: "photo.png",
			size: { width: 300, height: 200 },
		});
	});

	it("keeps spaced filenames intact", () => {
		expect(parseResizeToken("Figure 1.png|300")).toEqual({
			base: "Figure 1.png",
			size: { width: 300, height: null },
		});
	});

	it("trims surrounding whitespace", () => {
		expect(parseResizeToken("  photo.png | 300  ")).toEqual({
			base: "photo.png",
			size: { width: 300, height: null },
		});
	});

	it("yields no size when the token is missing", () => {
		expect(parseResizeToken("photo.png")).toEqual({
			base: "photo.png",
			size: null,
		});
	});

	it("yields no size for empty/invalid suffixes", () => {
		expect(parseResizeToken("photo.png|")).toEqual({
			base: "photo.png|",
			size: null,
		});
		expect(parseResizeToken("photo.png|abc")).toEqual({
			base: "photo.png|abc",
			size: null,
		});
		expect(parseResizeToken("photo.png|300px")).toEqual({
			base: "photo.png|300px",
			size: null,
		});
		expect(parseResizeToken("photo.png|0")).toEqual({
			base: "photo.png|0",
			size: null,
		});
		expect(parseResizeToken("photo.png|300x0")).toEqual({
			base: "photo.png|300x0",
			size: null,
		});
	});

	it("never parses [[Note|Custom Text]] aliases as sizes", () => {
		expect(parseResizeToken("Note|Custom Text")).toEqual({
			base: "Note|Custom Text",
			size: null,
		});
		expect(parseResizeToken("Three laws of motion|The 3 laws")).toEqual({
			base: "Three laws of motion|The 3 laws",
			size: null,
		});
		expect(
			parseResizeToken("About Obsidian#Links are first-class citizens|Custom Title")
		).toEqual({
			base: "About Obsidian#Links are first-class citizens|Custom Title",
			size: null,
		});
	});

	it("leaves multi-pipe targets intact", () => {
		expect(parseResizeToken("a|b|300")).toEqual({
			base: "a|b|300",
			size: null,
		});
	});
});

describe("parseResizeToken (Markdown-image shapes)", () => {
	it("parses label alt|400 with dest photo.png", () => {
		const dest = "photo.png";
		expect(dest).toBe("photo.png");
		expect(parseResizeToken("alt|400")).toEqual({
			base: "alt",
			size: { width: 400, height: null },
		});
	});

	it("parses label WxH alt|300x200", () => {
		expect(parseResizeToken("alt|300x200")).toEqual({
			base: "alt",
			size: { width: 300, height: 200 },
		});
	});

	it("keeps multi-word alt text", () => {
		expect(parseResizeToken("Photo alt text|400")).toEqual({
			base: "Photo alt text",
			size: { width: 400, height: null },
		});
	});

	it("yields no size for plain ![Alt](image.png) labels", () => {
		expect(parseResizeToken("Alt")).toEqual({ base: "Alt", size: null });
		expect(parseResizeToken("")).toEqual({ base: "", size: null });
	});

	it("yields no size for non-numeric label suffixes", () => {
		expect(parseResizeToken("alt|Custom")).toEqual({
			base: "alt|Custom",
			size: null,
		});
		expect(parseResizeToken("alt|400px")).toEqual({
			base: "alt|400px",
			size: null,
		});
	});
});
