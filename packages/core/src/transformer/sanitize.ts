/**
 * Headless HTML Sanitizer compatible with Obsidian's HTML passthrough requirements.
 *
 * Obsidian allows most HTML tags (div, span, u, sub, sup, s, table, iframe, etc.)
 * but strictly sanitizes dangerous tags (like <script>, <object>, <embed>),
 * strips event handlers (onclick, onerror, onload, etc.), and neutralizes
 * unsafe URL schemes (javascript:, vbscript:, etc.).
 *
 * Runs purely in headless environments without DOM / window globals (ADR 0002).
 */

const DANGEROUS_TAGS_REGEX = /<\s*(script|object|embed|applet|noscript)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>|<\s*(base|meta|link)\b[^>]*\/?>|<\s*(script|object|embed|applet|noscript)\b[^>]*\/?>/gi;

const ALLOWED_TAGS = new Set([
	'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo',
	'blockquote', 'br', 'button', 'caption', 'cite', 'code', 'col', 'colgroup',
	'data', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption',
	'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
	'hr', 'i', 'iframe', 'img', 'ins', 'kbd', 'label', 'legend', 'li', 'main',
	'map', 'mark', 'meter', 'nav', 'ol', 'p', 'picture', 'pre', 'progress', 'q',
	'rp', 'rt', 'ruby', 's', 'samp', 'section', 'select', 'small', 'source',
	'span', 'strong', 'sub', 'summary', 'sup', 'svg', 'path', 'circle', 'rect',
	'line', 'polyline', 'polygon', 'table', 'tbody', 'td', 'tfoot', 'th',
	'thead', 'time', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
]);

const URL_ATTRS = new Set(['href', 'src', 'poster', 'cite', 'data', 'action', 'formaction']);

const SAFE_ATTRS = new Set([
	'id', 'class', 'style', 'title', 'alt', 'width', 'height', 'align', 'valign',
	'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'target', 'rel',
	'loading', 'controls', 'autoplay', 'loop', 'muted', 'playsinline', 'open',
	'type', 'start', 'reversed', 'name', 'value', 'placeholder', 'role', 'dir',
	'lang', 'frameborder', 'allow', 'allowfullscreen', 'aria-label', 'aria-hidden',
	'aria-describedby', 'aria-expanded', 'aria-checked', 'aria-controls',
	'viewbox', 'xmlns', 'fill', 'stroke', 'stroke-width', 'd', 'cx', 'cy', 'r',
	'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points',
]);

function decodeEntities(val: string): string {
	return val
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

export function isSafeUrl(url: string, tagName?: string): boolean {
	if (!url) return true;
	const trimmed = decodeEntities(url).trim().toLowerCase().replace(/[\x00-\x20]/g, '');
	if (/^(javascript|vbscript):/.test(trimmed)) {
		return false;
	}
	if (/^data:/.test(trimmed)) {
		// Disallow data: URLs in iframes or navigation links to prevent script execution
		if (tagName && ['iframe', 'a', 'area', 'frame'].includes(tagName.toLowerCase())) {
			return false;
		}
		// Allow safe raster data URIs for images (strictly exclude svg+xml which executes scripts)
		if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(trimmed)) {
			return true;
		}
		return false;
	}
	return true;
}

export function isSafeStyle(style: string): boolean {
	if (!style) return true;
	const decoded = decodeEntities(style).toLowerCase().replace(/[\x00-\x20]/g, '');
	if (
		decoded.includes('javascript:') ||
		decoded.includes('expression(') ||
		decoded.includes('-moz-binding') ||
		decoded.includes('@import') ||
		decoded.includes('behavior:')
	) {
		return false;
	}
	return true;
}

function escapeHtmlAttr(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/**
 * Sanitizes HTML string by stripping unsafe tags (script, object, etc.),
 * removing on* event handlers, filtering unsafe URLs and malicious styles,
 * while preserving valid Obsidian HTML passthrough tags and attributes.
 */
export function sanitizeHtml(html: string): string {
	if (!html) return '';

	// 1. Repeatedly strip dangerous tags (handles nested obfuscation like <scr<script>ipt>)
	let sanitized = html;
	let prev = '';
	while (sanitized !== prev) {
		prev = sanitized;
		sanitized = sanitized.replace(DANGEROUS_TAGS_REGEX, '');
	}

	// 2. Tokenize and sanitize all HTML tags and comments
	const TAG_OR_COMMENT_REGEX = /<!--[\s\S]*?-->|<\/?[a-zA-Z0-9:-]+(?:\s+[^>]*?)?\/?>/g;

	return sanitized.replace(TAG_OR_COMMENT_REGEX, (token) => {
		// Preserve HTML comments
		if (token.startsWith('<!--')) {
			return token;
		}

		// Match tag structure: <(/)? (tagname) (attributes)? (/)? >
		const tagMatch = /^<(\/)?\s*([a-zA-Z0-9:-]+)([\s\S]*?)(\/)?>$/.exec(token);
		if (!tagMatch) {
			return '';
		}

		const isClosing = Boolean(tagMatch[1]);
		const rawTagName = tagMatch[2];
		const tagName = rawTagName.toLowerCase();
		const rawAttrs = tagMatch[3] || '';
		const isSelfClosing = Boolean(tagMatch[4]);

		// If tag is not in allowed whitelist, strip tag
		if (!ALLOWED_TAGS.has(tagName)) {
			return '';
		}

		if (isClosing) {
			return `</${tagName}>`;
		}

		// Parse attributes: attrName = "val" | 'val' | val
		const ATTR_REGEX = /([a-zA-Z0-9:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
		const cleanAttrs: string[] = [];
		let attrMatch: RegExpExecArray | null;

		while ((attrMatch = ATTR_REGEX.exec(rawAttrs)) !== null) {
			const rawAttrName = attrMatch[1];
			const attrName = rawAttrName.toLowerCase();
			const attrVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';

			// 1. Strip all on* event handlers (onclick, onerror, onload, etc.)
			if (attrName.startsWith('on')) {
				continue;
			}

			// 2. Check URL attributes
			if (URL_ATTRS.has(attrName)) {
				if (!isSafeUrl(attrVal, tagName)) {
					continue;
				}
				cleanAttrs.push(`${attrName}="${escapeHtmlAttr(decodeEntities(attrVal))}"`);
				continue;
			}

			// 3. Check style attribute
			if (attrName === 'style') {
				if (!isSafeStyle(attrVal)) {
					continue;
				}
				cleanAttrs.push(`style="${escapeHtmlAttr(decodeEntities(attrVal))}"`);
				continue;
			}

			// 4. Check safe attributes or data-*/aria-* attributes
			if (
				SAFE_ATTRS.has(attrName) ||
				attrName.startsWith('data-') ||
				attrName.startsWith('aria-')
			) {
				if (attrMatch[2] !== undefined || attrMatch[3] !== undefined || attrMatch[4] !== undefined) {
					cleanAttrs.push(`${attrName}="${escapeHtmlAttr(decodeEntities(attrVal))}"`);
				} else {
					cleanAttrs.push(attrName);
				}
			}
		}

		const attrsStr = cleanAttrs.length > 0 ? ` ${cleanAttrs.join(' ')}` : '';
		return isSelfClosing ? `<${tagName}${attrsStr} />` : `<${tagName}${attrsStr}>`;
	});
}
