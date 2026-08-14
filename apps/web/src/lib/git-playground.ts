import type { GitChange } from '@np/core';

export interface PlaygroundChange extends GitChange {
	_id: string;
}

export interface PlaygroundScene {
	name: string;
	description: string;
	changes: PlaygroundChange[];
}

let counter = 0;

function mk(c: {
	filepath: string;
	status: GitChange['status'];
	originalContent: string;
	modifiedContent: string;
	staged?: boolean;
	diff?: string;
	additions?: number;
	deletions?: number;
}): PlaygroundChange {
	return {
		filepath: c.filepath,
		status: c.status,
		originalContent: c.originalContent,
		modifiedContent: c.modifiedContent,
		staged: c.staged ?? false,
		diff: c.diff ?? '',
		additions: c.additions ?? 0,
		deletions: c.deletions ?? 0,
		_id: `pg-${++counter}`
	};
}

const HEAD_HELLO = `export function greet(name: string): string {
	return \`Hello, \${name}\`;
}

export function farewell(name: string): string {
	return \`Goodbye, \${name}\`;
}`;

const WORK_HELLO = `export function greet(name: string): string {
	return \`Hello, \${name}\`;
}

export function farewell(name: string): string {
	return \`Goodbye, \${name}. See you soon\`;
}`;

const HEAD_UTILS = `export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export function sum(values: number[]): number {
	return values.reduce((acc, v) => acc + v, 0);
}

export function average(values: number[]): number {
	return sum(values) / values.length;
}`;

const WORK_UTILS = `export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max).toFixed(2);
}

export function sum(values: number[]): number {
	return values.reduce((acc, v) => acc + v, 0);
}

export function average(values: number[]): number {
	if (values.length === 0) return 0;
	return sum(values) / values.length;
}`;

const HEAD_APP = `const title = 'Weather App';

function render() {
	console.log(title);
}

render();`;

const INDEX_APP = `const title = 'Weather App v2';

function render() {
	console.log(title, 'ready');
}

render();`;

const WORK_APP = `const title = 'Weather App v3';

function render() {
	console.log(title, 'ready');
}

render();
setInterval(render, 1000);`;

const ADDED_DRAFT = `# Draft

Things to do:
- ship the diff playground
- write tests`;

const DELETED_CONFIG = `[app]
name = legacy
enabled = false`;

const API_ORIG = `export function fetchTodos(): string[] {
	return [];
}

export function fetchUsers(): string[] {
	return [];
}`;

const API_MOD = `export function fetchTodos(): string[] {
	return fetch('/todos').then((r) => r.json());
}

export async function fetchUsers(): Promise<string[]> {
	return fetch('/users').then((r) => r.json());
}`;

const API_TEST = `import { describe, it, expect } from 'bun:test';

describe('api', () => {
	it('has tests');
});`;

export function emptyChange(): PlaygroundChange {
	return mk({
		filepath: 'file.txt',
		status: 'M',
		originalContent: '',
		modifiedContent: ''
	});
}

export function freshChange(change: PlaygroundChange): PlaygroundChange {
	return { ...change };
}

export const SCENES: PlaygroundScene[] = [
	{
		name: 'Single modified file',
		description: 'One unstaged file with a small edit. Edit the green worktree text to watch the diff refresh live.',
		changes: [
			mk({
				filepath: 'src/hello.ts',
				status: 'M',
				originalContent: HEAD_HELLO,
				modifiedContent: WORK_HELLO,
				additions: 1,
				deletions: 1,
				diff: 'diff --git a/src/hello.ts b/src/hello.ts'
			})
		]
	},
	{
		name: 'Two hunks',
		description: 'A single file with two separated edit regions -> two hunk widgets (stage/unstage controls).',
		changes: [
			mk({
				filepath: 'src/utils.ts',
				status: 'M',
				originalContent: HEAD_UTILS,
				modifiedContent: WORK_UTILS,
				additions: 2,
				deletions: 1,
				diff: 'diff --git a/src/utils.ts b/src/utils.ts'
			})
		]
	},
	{
		name: 'Staged + unstaged',
		description: 'Same file with a staged and an unstaged change -> combined view (HEAD vs worktree, with staged content).',
		changes: [
			mk({
				filepath: 'app.js',
				status: 'M',
				staged: true,
				originalContent: HEAD_APP,
				modifiedContent: INDEX_APP,
				additions: 1,
				deletions: 1,
				diff: 'diff --git a/app.js b/app.js'
			}),
			mk({
				filepath: 'app.js',
				status: 'M',
				staged: false,
				originalContent: INDEX_APP,
				modifiedContent: WORK_APP,
				additions: 2,
				deletions: 1,
				diff: 'diff --git a/app.js b/app.js'
			})
		]
	},
	{
		name: 'Added file',
		description: 'A brand new untracked/added file: empty original, all additions.',
		changes: [
			mk({
				filepath: 'notes/draft.md',
				status: 'A',
				originalContent: '',
				modifiedContent: ADDED_DRAFT,
				additions: 5,
				deletions: 0,
				diff: 'diff --git a/notes/draft.md b/notes/draft.md'
			})
		]
	},
	{
		name: 'Deleted file',
		description: 'A file removed from the worktree: all deletions on the right.',
		changes: [
			mk({
				filepath: 'legacy/config.ini',
				status: 'D',
				originalContent: DELETED_CONFIG,
				modifiedContent: '',
				additions: 0,
				deletions: 3,
				diff: 'diff --git a/legacy/config.ini b/legacy/config.ini'
			})
		]
	},
	{
		name: 'Multiple files',
		description: 'Several files with mixed statuses (Modified, Added, staged) in one view.',
		changes: [
			mk({
				filepath: 'src/api.ts',
				status: 'M',
				originalContent: API_ORIG,
				modifiedContent: API_MOD,
				additions: 2,
				deletions: 1,
				diff: 'diff --git a/src/api.ts b/src/api.ts'
			}),
			mk({
				filepath: 'src/api.test.ts',
				status: 'A',
				originalContent: '',
				modifiedContent: API_TEST,
				additions: 5,
				deletions: 0,
				diff: 'diff --git a/src/api.test.ts b/src/api.test.ts'
			}),
			mk({
				filepath: 'README.md',
				status: 'M',
				staged: true,
				originalContent: '# np\n\nTest playground below.',
				modifiedContent: '# np\n\nTest playground below.\n\n=> manual testing!',
				additions: 1,
				deletions: 1,
				diff: 'diff --git a/README.md b/README.md'
			})
		]
	}
];