import '../../../../tests/contract/rune-setup';
import { describe, it, expect, mock, spyOn } from 'bun:test';
import { PluginHost } from './host.svelte';
import { HookReentryError, SaveCancelledError } from './errors';
import { Workspace } from '../workspace.svelte';
import { DocumentSession } from '../document.svelte';
import { MemorySessionPersistence } from '../persistence';
import type { FileOrigin, Storage } from '../storage';
import type { VCSAdapter } from '../project/vcs';
import { Repository } from '../project/repository.svelte';

function createLocalMockStorage(initialFiles: Record<string, string> = {}): Storage {
	const files = new Map<string, string>(Object.entries(initialFiles));
	return {
		readFile: mock(async (origin: FileOrigin) => {
			const content = files.get(origin.path);
			if (content === undefined) throw new Error(`Not found: ${origin.path}`);
			return content;
		}),
		writeFile: mock(async (origin: FileOrigin, content: string) => {
			files.set(origin.path, content);
		}),
		saveFile: mock(async (content: string, existingOrigin?: FileOrigin) => {
			const origin = existingOrigin ?? { scheme: 'file', path: '/saved.md', name: 'saved.md' };
			files.set(origin.path, content);
			return origin;
		}),
		openFileDialog: mock(async () => null),
		openDirectoryDialog: mock(async () => null),
		saveFileDialog: mock(async () => null),
		readDirectory: mock(async () => []),
		exists: mock(async (origin: FileOrigin) => files.has(origin.path)),
		deleteFile: mock(async (origin: FileOrigin) => {
			files.delete(origin.path);
		}),
		deleteDirectory: mock(async () => {}),
		verifyPermission: mock(async () => true),
		queryPermission: mock(async () => 'granted' as const),
		pickFile: mock(async () => null),
		pickDirectory: mock(async () => null),
		createFile: mock(async (parent: FileOrigin, name: string) => ({ scheme: 'file', path: `/${name}`, name })),
		createDirectory: mock(async (parent: FileOrigin, name: string) => ({ scheme: 'file', path: `/${name}`, name })),
		deleteEntry: mock(async () => {}),
		renameEntry: mock(async (origin: FileOrigin, newName: string) => ({ scheme: 'file', path: `/${newName}`, name: newName }))
	};
}

function createMockVcsFactory(refreshSpy?: () => Promise<boolean>): (root: FileOrigin) => VCSAdapter {
	return () => ({
		detect: mock(async () => true),
		getCurrentBranch: async () => 'main',
		getBranches: async () => ['main'],
		getChanges: async () => [],
		getCommits: async () => [],
		getStatus: async () => ({ isDirty: false, uncommittedFiles: [] }),
		switchBranch: mock(async () => ({ status: 'switched' as const })),
		refresh: refreshSpy ?? mock(async () => true)
	});
}

describe('Events and Document Save Hooks (#197, ADR 0013)', () => {
	describe('Event observation (on, off, emit)', () => {
		it('emits fire-and-forget events to subscribers for observation only', () => {
			const host = new PluginHost();
			const received: any[] = [];

			const unsub = host.on('doc:saved', (payload) => {
				received.push(payload);
			});

			host.emit('doc:saved', { id: 'doc-1', path: '/notes/a.md' });
			expect(received).toHaveLength(1);
			expect(received[0]).toEqual({ id: 'doc-1', path: '/notes/a.md' });

			unsub();
			host.emit('doc:saved', { id: 'doc-2', path: '/notes/b.md' });
			expect(received).toHaveLength(1);
		});

		it('allows unsubscribing via off() method', () => {
			const host = new PluginHost();
			let count = 0;
			const handler = () => {
				count++;
			};

			host.on('test-event', handler);
			host.emit('test-event');
			expect(count).toBe(1);

			host.off('test-event', handler);
			host.emit('test-event');
			expect(count).toBe(1);
		});

		it('contains throwing event handlers without interrupting emission or caller', () => {
			const host = new PluginHost();
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			let secondHandlerCalled = false;
			host.on('ping', () => {
				throw new Error('Boom in event handler');
			}, 'plugin-error');
			host.on('ping', () => {
				secondHandlerCalled = true;
			}, 'plugin-ok');

			expect(() => host.emit('ping', { foo: 'bar' })).not.toThrow();
			expect(secondHandlerCalled).toBe(true);
			expect(errorSpy).toHaveBeenCalled();

			errorSpy.mockRestore();
		});

		it('handles rejecting async event handlers gracefully', async () => {
			const host = new PluginHost();
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			host.on('async-event', async () => {
				throw new Error('Async error');
			}, 'plugin-async');

			expect(() => host.emit('async-event')).not.toThrow();
			// Wait for promise resolution tick
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(errorSpy).toHaveBeenCalled();

			errorSpy.mockRestore();
		});

		it('removes plugin event handlers on deactivation and unregister', async () => {
			const host = new PluginHost();
			let called = 0;

			host.register({
				manifest: { id: 'listener-plugin', name: 'Listener', version: 0 },
				setup: (h) => {
					h.on('lifecycle-event', () => {
						called++;
					}, 'listener-plugin');
				}
			});

			await host.activate('listener-plugin');
			host.emit('lifecycle-event');
			expect(called).toBe(1);

			await host.deactivate('listener-plugin');
			host.emit('lifecycle-event');
			expect(called).toBe(1);

			await host.activate('listener-plugin');
			host.emit('lifecycle-event');
			expect(called).toBe(2);

			await host.unregister('listener-plugin');
			host.emit('lifecycle-event');
			expect(called).toBe(2);
		});
	});

	describe('Document Save Hooks on PluginHost', () => {
		it('executes before-save hooks sequentially in plugin activation order and awaits them', async () => {
			const host = new PluginHost();
			const order: string[] = [];

			// Register plugin a and plugin b where b depends on a
			host.register({
				manifest: { id: 'plugin-b', name: 'Plugin B', version: 0, dependsOn: { 'plugin-a': 0 } },
				setup: (h) => {
					h.registerBeforeSaveHook('plugin-b', async () => {
						await new Promise((r) => setTimeout(r, 10));
						order.push('plugin-b');
					});
				}
			});
			host.register({
				manifest: { id: 'plugin-a', name: 'Plugin A', version: 0 },
				setup: (h) => {
					h.registerBeforeSaveHook('plugin-a', async () => {
						await new Promise((r) => setTimeout(r, 5));
						order.push('plugin-a');
					});
				}
			});

			// Activate all (activation order will be plugin-a then plugin-b)
			await host.activateAll();

			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			const result = await host.runBeforeSave({ document: doc });
			expect(result.cancel).toBe(false);
			expect(order).toEqual(['plugin-a', 'plugin-b']);
		});

		it('allows a before-save hook to cancel save with a user-visible reason via return object', async () => {
			const host = new PluginHost();

			host.registerBeforeSaveHook('linter', async () => {
				return { cancel: true, reason: 'Line 5: Unexpected syntax error' };
			});

			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			const result = await host.runBeforeSave({ document: doc });
			expect(result.cancel).toBe(true);
			expect(result.reason).toBe('Line 5: Unexpected syntax error');
		});

		it('allows a before-save hook to cancel save with SaveCancelledError', async () => {
			const host = new PluginHost();

			host.registerBeforeSaveHook('validator', async () => {
				throw new SaveCancelledError('Document contains uncommitted merge conflict markers');
			});

			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			const result = await host.runBeforeSave({ document: doc });
			expect(result.cancel).toBe(true);
			expect(result.reason).toBe('Document contains uncommitted merge conflict markers');
		});

		it('logs a throwing hook against its plugin while remaining hooks still run and save proceeds', async () => {
			const host = new PluginHost();
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			const executed: string[] = [];

			host.registerBeforeSaveHook('failing-plugin', async () => {
				executed.push('failing-plugin');
				throw new TypeError('Cannot read properties of undefined');
			});

			host.registerBeforeSaveHook('healthy-plugin', async () => {
				executed.push('healthy-plugin');
			});

			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			const result = await host.runBeforeSave({ document: doc });

			expect(result.cancel).toBe(false);
			expect(executed).toEqual(['failing-plugin', 'healthy-plugin']);
			expect(errorSpy).toHaveBeenCalled();
			expect(host.lastHookError?.pluginId).toBe('failing-plugin');

			errorSpy.mockRestore();
		});

		it('detects reentry when a hook calls save operation and fails with actionable HookReentryError naming the plugin', async () => {
			const host = new PluginHost();
			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			let caughtInHook: unknown = null;

			host.registerBeforeSaveHook('reentrant-plugin', async (ctx) => {
				try {
					// Attempting to re-enter runBeforeSave
					await host.runBeforeSave(ctx);
				} catch (err) {
					caughtInHook = err;
					throw err;
				}
			});

			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			const result = await host.runBeforeSave({ document: doc });

			// The hook's reentrant call threw HookReentryError
			expect(caughtInHook).toBeInstanceOf(HookReentryError);
			const reentryErr = caughtInHook as HookReentryError;
			expect(reentryErr.pluginId).toBe('reentrant-plugin');
			expect(reentryErr.message).toContain('reentrant-plugin');
			expect(reentryErr.message).toContain('re-entered saveDocument during beforeSave hook');
			expect(reentryErr.message).toContain('Action:');

			// Save still proceeds because unhandled hook errors do not veto
			expect(result.cancel).toBe(false);

			errorSpy.mockRestore();
		});

		it('removes hooks on deactivation and unregistration', async () => {
			const host = new PluginHost();
			let hookRan = false;

			host.register({
				manifest: { id: 'hook-plugin', name: 'Hook Plugin', version: 0 },
				setup: (h) => {
					h.registerBeforeSaveHook('hook-plugin', () => {
						hookRan = true;
					});
				}
			});

			await host.activate('hook-plugin');
			const storage = createLocalMockStorage();
			const doc = new DocumentSession(storage, '');

			await host.runBeforeSave({ document: doc });
			expect(hookRan).toBe(true);

			hookRan = false;
			await host.deactivate('hook-plugin');

			await host.runBeforeSave({ document: doc });
			expect(hookRan).toBe(false);

			await host.unregister('hook-plugin');
			await host.runBeforeSave({ document: doc });
			expect(hookRan).toBe(false);
		});
	});

	describe('Workspace.saveDocument Integration', () => {
		it('cancels save when a before-save hook cancels with a reason the user sees', async () => {
			const host = new PluginHost();
			const storage = createLocalMockStorage();
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);

			host.registerBeforeSaveHook('formatter', async () => {
				return { cancel: true, reason: 'Formatting failed: missing semicolon' };
			});

			const origin: FileOrigin = { scheme: 'file', path: '/test.md', name: 'test.md' };
			const doc = new DocumentSession(storage, '', origin);
			doc.content = '# Test Content';

			const saved = await workspace.saveDocument(doc);
			expect(saved).toBe(false);
			expect(workspace.lastSaveCancellationReason).toBe('Formatting failed: missing semicolon');
			// Storage write was never called
			expect(storage.saveFile).not.toHaveBeenCalled();
		});

		it('proceeds with save and remaining hooks when a hook throws an error', async () => {
			const host = new PluginHost();
			const storage = createLocalMockStorage({ '/test.md': '' });
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);

			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			let afterHookRan = false;
			host.registerBeforeSaveHook('faulty-hook', () => {
				throw new Error('Unexpected crash in hook');
			});
			host.registerAfterSaveHook('after-hook', () => {
				afterHookRan = true;
			});

			const origin: FileOrigin = { scheme: 'file', path: '/test.md', name: 'test.md' };
			const doc = new DocumentSession(storage, '', origin);
			doc.content = 'Updated content';

			const saved = await workspace.saveDocument(doc);
			expect(saved).toBe(true);
			expect(afterHookRan).toBe(true);
			expect(storage.saveFile).toHaveBeenCalled();

			errorSpy.mockRestore();
		});

		it('fails reentrant saveDocument calls with actionable HookReentryError naming the plugin', async () => {
			const host = new PluginHost();
			const storage = createLocalMockStorage({ '/test.md': '', '/other.md': '' });
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);

			const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

			let caughtReentryError: unknown = null;

			const otherOrigin: FileOrigin = { scheme: 'file', path: '/other.md', name: 'other.md' };
			const otherDoc = new DocumentSession(storage, '', otherOrigin);

			host.registerBeforeSaveHook('recursive-saver', async () => {
				try {
					await workspace.saveDocument(otherDoc);
				} catch (err) {
					caughtReentryError = err;
					throw err;
				}
			});

			const origin: FileOrigin = { scheme: 'file', path: '/test.md', name: 'test.md' };
			const doc = new DocumentSession(storage, '', origin);

			const saved = await workspace.saveDocument(doc);
			expect(saved).toBe(true);

			expect(caughtReentryError).toBeInstanceOf(HookReentryError);
			const err = caughtReentryError as HookReentryError;
			expect(err.pluginId).toBe('recursive-saver');
			expect(err.message).toContain('recursive-saver');
			expect(err.message).toContain('re-entered saveDocument during beforeSave hook');
			expect(err.message).toContain('Action: Avoid calling save operations from within a save hook');

			errorSpy.mockRestore();
		});

		it('flows repository refresh on save through the new afterSave mechanism with no behavior change', async () => {
			const host = new PluginHost();
			const storage = createLocalMockStorage({ '/repo/file.md': '' });
			const persistence = new MemorySessionPersistence();

			const vcsFactory = createMockVcsFactory();
			const workspace = new Workspace(storage, vcsFactory, persistence, host);

			// Open a folder so workspace.repository is initialized
			const rootOrigin: FileOrigin = { scheme: 'file', path: '/repo', name: 'repo' };
			workspace.rootOrigin = rootOrigin;
			workspace.hasRootPermission = true;
			const repo = new Repository(rootOrigin, vcsFactory);
			const refreshSpy = spyOn(repo, 'refresh');
			workspace.repository = repo;

			const fileOrigin: FileOrigin = { scheme: 'file', path: '/repo/file.md', name: 'file.md' };
			const doc = new DocumentSession(storage, '', fileOrigin);
			doc.content = 'Updated file content';

			expect(refreshSpy).not.toHaveBeenCalled();

			const saved = await workspace.saveDocument(doc);
			expect(saved).toBe(true);

			// Verify repository.refresh() was called via afterSave hook
			expect(refreshSpy).toHaveBeenCalled();

			refreshSpy.mockRestore();
		});

		it('emits document:saved event upon successful save', async () => {
			const host = new PluginHost();
			const storage = createLocalMockStorage({ '/notes/memo.md': '' });
			const persistence = new MemorySessionPersistence();
			const workspace = new Workspace(storage, createMockVcsFactory(), persistence, host);

			const savedEvents: any[] = [];
			host.on('document:saved', (payload) => {
				savedEvents.push(payload);
			});

			const origin: FileOrigin = { scheme: 'file', path: '/notes/memo.md', name: 'memo.md' };
			const doc = new DocumentSession(storage, '', origin);
			doc.content = 'Important memo';

			await workspace.saveDocument(doc);

			expect(savedEvents).toHaveLength(1);
			expect(savedEvents[0].document).toBe(doc);
			expect(savedEvents[0].origin).toEqual(origin);
		});
	});
});
