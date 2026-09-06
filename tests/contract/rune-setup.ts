import { mock } from "bun:test";

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
