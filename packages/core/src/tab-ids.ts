/**
 * The ids the workspace gives to the tabs it opens by itself.
 *
 * They live here, apart from the workspace, so that code which cannot load
 * the workspace can still name a tab. The project search tab, for one, has to
 * recognise its own id to decide whether it should take the focus.
 */
export const SEARCH_TAB_ID = '__project_search__';
