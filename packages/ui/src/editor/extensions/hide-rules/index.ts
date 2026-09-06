import type { HideMarkerRule } from "./types";
import { listMarkerRule } from "./list";
import { headerMarkerRule } from "./header";
import { quoteMarkerRule } from "./quote";
import { genericMarkerRule } from "./generic";

/**
 * Central marker-hiding rule list. Order matters: `find()` picks the first
 * matching rule, so feature-specific rules come before the catch-all
 * `genericMarkerRule`. To add a feature's marker hiding, append its rule
 * module to this array — the only collision point is this adjacent list.
 */
export const markerHideRules: HideMarkerRule[] = [
	listMarkerRule,
	headerMarkerRule,
	quoteMarkerRule,
	genericMarkerRule,
];

export type { HideMarkerRule } from "./types";