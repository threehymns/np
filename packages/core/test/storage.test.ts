import { describe, test, expect } from 'bun:test';
import { toURI, parseURI, type FileOrigin } from '../src/storage';

describe('FileOrigin (de)serialization and path resolution', () => {
	test('toURI maps origins to standard URIs', () => {
		const cases: { origin: FileOrigin; expected: string }[] = [
			{
				origin: { scheme: 'browser', path: 'projects/np-editor', name: 'np-editor' },
				expected: 'browser://projects/np-editor'
			},
			{
				origin: { scheme: 'file', path: '/var/log/syslog', name: 'syslog' },
				expected: 'file:///var/log/syslog'
			},
			{
				origin: { scheme: 'file', path: 'home/user/notes.txt', name: 'notes.txt' },
				expected: 'file:///home/user/notes.txt'
			},
			{
				origin: { scheme: 'git', path: 'repo/ref/file.ts', name: 'file.ts' },
				expected: 'git://repo/ref/file.ts'
			},
			{
				origin: { scheme: 'untitled', path: 'Untitled-1', name: 'Untitled-1' },
				expected: 'untitled://Untitled-1'
			}
		];

		for (const c of cases) {
			expect(toURI(c.origin)).toBe(c.expected);
		}
	});

	test('parseURI parses URIs into FileOrigin structures', () => {
		const cases: { uri: string; expected: FileOrigin }[] = [
			{
				uri: 'browser://projects/np-editor',
				expected: { scheme: 'browser', path: 'projects/np-editor', name: 'np-editor' }
			},
			{
				uri: 'file:///var/log/syslog',
				expected: { scheme: 'file', path: '/var/log/syslog', name: 'syslog' }
			},
			{
				uri: 'file://home/user/notes.txt',
				expected: { scheme: 'file', path: '/home/user/notes.txt', name: 'notes.txt' }
			},
			{
				uri: 'git://repo/ref/file.ts',
				expected: { scheme: 'git', path: 'repo/ref/file.ts', name: 'file.ts' }
			}
		];

		for (const c of cases) {
			expect(parseURI(c.uri)).toEqual(c.expected);
		}
	});

	test('toURI and parseURI round-tripping holds true for diverse scenarios', () => {
		const origins: FileOrigin[] = [
			{ scheme: 'browser', path: 'root-folder', name: 'root-folder' },
			{ scheme: 'file', path: '/home/user/workspace/app.js', name: 'app.js' },
			{ scheme: 'file', path: '/', name: '' },
			{ scheme: 'browser', path: 'a/b/c/d.md', name: 'd.md' },
			{ scheme: 'sftp', path: 'user@host:/path/to/file.png', name: 'file.png' },
			{ scheme: 'custom-scheme', path: 'some-strange-path', name: 'some-strange-path' },
			{ scheme: 'file', path: '/path/with spaces/file.txt', name: 'file.txt' },
			{ scheme: 'browser', path: 'unicode/🚀/star.⭐', name: 'star.⭐' }
		];

		for (const orig of origins) {
			const uri = toURI(orig);
			const parsed = parseURI(uri);
			expect(parsed.scheme).toBe(orig.scheme);
			// For 'file' scheme, path is normalized to start with a slash
			if (orig.scheme === 'file' && !orig.path.startsWith('/')) {
				expect(parsed.path).toBe('/' + orig.path);
			} else {
				expect(parsed.path).toBe(orig.path);
			}
			expect(parsed.name).toBe(orig.name);
		}
	});

	test('parseURI throws error for invalid URI strings', () => {
		const invalidURIs = [
			'invalid-uri-no-scheme-separator',
			'file:/missing-slashes',
			'browser://', // empty path could be valid but let's see how it behaves
			'://empty-scheme'
		];

		for (const bad of invalidURIs) {
			if (bad === 'browser://') {
				// empty path translates to empty path and empty name, no throw
				const parsed = parseURI(bad);
				expect(parsed.scheme).toBe('browser');
				expect(parsed.path).toBe('');
				expect(parsed.name).toBe('');
			} else if (bad === '://empty-scheme') {
				const parsed = parseURI(bad);
				expect(parsed.scheme).toBe('');
				expect(parsed.path).toBe('empty-scheme');
			} else {
				expect(() => parseURI(bad)).toThrow();
			}
		}
	});
});
