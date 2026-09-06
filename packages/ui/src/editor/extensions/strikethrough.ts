import type { MarkdownConfig } from "@lezer/markdown";
import { styleTags, tags as t } from "@lezer/highlight";

/**
 * Strikethrough visibility. GFM already parses `~~struck~~` into
 * `Strikethrough` + `StrikethroughMark` nodes; this config just tags the
 * Strikethrough node so the live-source style chunk can render it struck
 * through. No parsing behavior change.
 */
export const StrikethroughExtension: MarkdownConfig = {
	props: [
		styleTags({
			Strikethrough: t.strikethrough,
		}),
	],
};