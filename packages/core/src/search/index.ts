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
	type FileMatchScan,
	SearchResultStream as EngineSearchResultStream,
	TypeScriptSearchEngine,
	buildSearchRegex,
	findMatchesInContent,
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
	type ExcerptMapBuild,
	computeLineStarts,
	FileExcerptMap,
	isExcerptMapStale,
	buildExcerptMapForContent,
	buildReplaceAllEditsForFile,
	applyEditsToDocumentSession,
	applyReplaceAll
} from './excerpt';
