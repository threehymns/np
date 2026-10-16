export type {
	SearchQuery,
	SearchMatchContextLine,
	SearchMatch,
	FileSearchResult,
	SearchProgress,
	SearchOptions,
	SearchResultStream,
	SearchBackend
} from './types';

export {
	DEFAULT_MAX_FILES,
	DEFAULT_MAX_MATCHES,
	SNIFF_SIZE,
	type FlattenedFile,
	SearchResultStream as EngineSearchResultStream,
	TypeScriptSearchEngine,
	buildSearchRegex,
	globToRegex,
	parseGlobs
} from './engine';

export {
	SearchTabSession,
	type SearchTabSessionOptions
} from './session.svelte';

export {
	type SingleEdit,
	type ExcerptSegment,
	type ExcerptMapOptions,
	computeLineStarts,
	FileExcerptMap,
	buildReplaceAllEditsForFile,
	applyEditsToDocumentSession,
	applyReplaceAll
} from './excerpt';
