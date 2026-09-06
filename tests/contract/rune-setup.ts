import { mock } from "bun:test";
import { plugin } from "bun";
import { readFileSync } from "node:fs";

function transformRunes(source: string): string {
	const regex = /([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*\$derived(\.by)?\s*\(/g;
	let result = "";
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(source)) !== null) {
		const fullMatch = match[0];
		const prop = match[1];
		const isBy = !!match[2];
		const matchStart = match.index;
		const openParenIndex = matchStart + fullMatch.length - 1;

		result += source.slice(lastIndex, matchStart);

		let depth = 1;
		let j = openParenIndex + 1;
		let inString: string | null = null;
		let inComment: "line" | "block" | null = null;

		while (j < source.length && depth > 0) {
			const c = source[j];
			const next = source[j + 1];

			if (inComment === "line") {
				if (c === "\n") inComment = null;
			} else if (inComment === "block") {
				if (c === "*" && next === "/") {
					inComment = null;
					j++;
				}
			} else if (inString) {
				if (c === "\\") {
					j++;
				} else if (c === inString) {
					inString = null;
				}
			} else {
				if (c === "/" && next === "/") {
					inComment = "line";
					j++;
				} else if (c === "/" && next === "*") {
					inComment = "block";
					j++;
				} else if (c === '"' || c === "'" || c === "`") {
					inString = c;
				} else if (c === "(" || c === "{" || c === "[") {
					depth++;
				} else if (c === ")" || c === "}" || c === "]") {
					depth--;
				}
			}
			j++;
		}

		const inner = source.slice(openParenIndex + 1, j - 1);
		let after = source.slice(j);
		let semiOffset = 0;
		if (after.startsWith(";")) {
			semiOffset = 1;
		}

		if (isBy) {
			result += "get " + prop + "() { return (" + inner.trim() + ")(); }";
		} else {
			result += "get " + prop + "() { return (" + inner.trim() + "); }";
		}

		lastIndex = j + semiOffset;
		regex.lastIndex = lastIndex;
	}

	result += source.slice(lastIndex);
	return result;
}

plugin({
	name: "svelte-ts-rune-transform",
	setup(build) {
		build.onLoad({ filter: /\.svelte\.ts$/ }, ({ path }) => {
			const text = readFileSync(path, "utf-8");
			return {
				contents: transformRunes(text),
				loader: "ts"
			};
		});
	}
});

// Svelte 5 rune stubs for test environments that do not compile Svelte components
// (the contract suite runs `commands.svelte`/`repository.svelte` logic through
// bun). Load this module before any Svelte module import so `$state`/`$derived`/
// `$effect` resolve at module evaluation time.
(globalThis as any).$state = Object.assign(<T>(v: T) => v, {
	snapshot: <T>(v: T) => v,
	raw: <T>(v: T) => v
});
(globalThis as any).$derived = Object.assign(<T>(v: T) => v, {
	by: (fn: any) => fn()
});
(globalThis as any).$effect = Object.assign(() => {}, {
	root: (cb: () => void) => {
		cb();
		return () => {};
	}
});

mock.module("svelte", () => ({
	getContext: () => null,
	setContext: () => {},
	hasContext: () => false,
	getAllContexts: () => new Map(),
	untrack: (fn: any) => fn(),
	tick: async () => {},
	mount: (component: any, options: any) => ({}),
	unmount: (instance: any) => {},
}));

mock.module("svelte/reactivity", () => ({
	SvelteMap: Map,
	SvelteSet: Set
}));
