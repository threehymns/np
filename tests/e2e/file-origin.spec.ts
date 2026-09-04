import { test, expect } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';

test.describe('FileOrigin & Registry Tests', () => {
  test('toURI and parseURI round-tripping for browser and file schemes', async ({ page }) => {
    await mockIconThemes(page);
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).toURI === 'function');

    const roundtripResult = await page.evaluate(async () => {
      // @ts-ignore
      const { toURI, parseURI } = window;

      const cases = [
        { scheme: 'browser', path: 'my-project/file.md', name: 'file.md' },
        { scheme: 'file', path: '/home/user/notes/test.txt', name: 'test.txt' },
        { scheme: 'browser', path: 'root-folder', name: 'root-folder' },
        { scheme: 'file', path: '/var/log/syslog', name: 'syslog' },
      ];

      const results = cases.map(orig => {
        const uri = toURI(orig);
        const parsed = parseURI(uri);
        return {
          original: orig,
          uri,
          parsed,
          success: orig.scheme === parsed.scheme && orig.path === parsed.path && orig.name === parsed.name
        };
      });

      return results;
    });

    for (const r of roundtripResult) {
      expect(r.success).toBe(true);
      if (r.original.scheme === 'file') {
        expect(r.uri).toBe(`file://${r.original.path}`);
      } else {
        expect(r.uri).toBe(`${r.original.scheme}://${r.original.path}`);
      }
    }
  });

  test('browserHandleRegistry stores and resolves handles correctly', async ({ page }) => {
    await mockIconThemes(page);
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).browserHandleRegistry !== 'undefined');

    const registryResult = await page.evaluate(async () => {
      // @ts-ignore
      const { browserHandleRegistry, toURI } = window;

      // Create dummy/mock handles for testing
      const mockFileHandle = {
        kind: 'file',
        name: 'test-file.md',
        getFile: async () => new File(['file content'], 'test-file.md'),
      };
      
      const mockDirHandle = {
        kind: 'directory',
        name: 'test-dir',
      };

      const fileOrigin = { scheme: 'browser', path: 'test-dir/test-file.md', name: 'test-file.md' };
      const dirOrigin = { scheme: 'browser', path: 'test-dir', name: 'test-dir' };

      const fileUri = toURI(fileOrigin);
      const dirUri = toURI(dirOrigin);

      // Register them
      // @ts-ignore
      await browserHandleRegistry.register(fileUri, mockFileHandle);
      // @ts-ignore
      await browserHandleRegistry.register(dirUri, mockDirHandle);

      // Retrieve directly
      const resolvedFileDirect = await browserHandleRegistry.get(fileUri);
      const resolvedDirDirect = await browserHandleRegistry.get(dirUri);

      // Resolve via path traversal fallback (e.g. resolve descendant from parent directory)
      const resolvedFileDescendant = {
        kind: 'file',
        name: 'child-file.md',
      };
      const mockDirWithChildren = {
        kind: 'directory',
        name: 'project-root',
        getDirectoryHandle: async () => {},
        getFileHandle: async (name: string) => {
          if (name === 'child-file.md') return resolvedFileDescendant;
          throw new Error('Not found');
        }
      };

      const rootOrigin = { scheme: 'browser', path: 'project-root', name: 'project-root' };
      const rootUri = toURI(rootOrigin);
      // @ts-ignore
      await browserHandleRegistry.register(rootUri, mockDirWithChildren);

      const childOrigin = { scheme: 'browser', path: 'project-root/child-file.md', name: 'child-file.md' };
      const childUri = toURI(childOrigin);
      const resolvedChild = await browserHandleRegistry.resolve(childUri);

      return {
        resolvedFileDirect: resolvedFileDirect?.name,
        resolvedDirDirect: resolvedDirDirect?.name,
        resolvedChild: resolvedChild?.name,
      };
    });

    expect(registryResult.resolvedFileDirect).toBe('test-file.md');
    expect(registryResult.resolvedDirDirect).toBe('test-dir');
    expect(registryResult.resolvedChild).toBe('child-file.md');
  });

  test('file.open command converts supported raw paths and handles unsupported paths cleanly', async ({ page }) => {
    await mockIconThemes(page);
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).appState !== 'undefined');

    const result = await page.evaluate(async () => {
      // @ts-ignore
      const appState = window.appState;
      const openedOrigins: any[] = [];

      // Spy on appState.workspace.openFile
      const originalOpenFile = appState.workspace.openFile.bind(appState.workspace);
      appState.workspace.openFile = async (origin: any) => {
        openedOrigins.push(origin);
        return undefined;
      };

      try {
        // 1. Scheme-less target without rootOrigin - relative path (unsupported)
        appState.workspace.rootOrigin = null;
        let relativeThrew = false;
        try {
          await appState.commands.execute('file.open', 'unrooted-relative.md');
        } catch (e) {
          relativeThrew = true;
        }

        // 2. Scheme-less target without rootOrigin - absolute POSIX path
        await appState.commands.execute('file.open', '/var/log/app.log');

        // 3. Scheme-less target without rootOrigin - Windows path
        await appState.commands.execute('file.open', 'C:\\Users\\notes\\todo.txt');

        // 4. URI target
        await appState.commands.execute('file.open', 'file:///etc/hosts');

        // 5. Scheme-less target with rootOrigin
        appState.workspace.rootOrigin = { scheme: 'browser', path: 'workspace-dir', name: 'workspace-dir' };
        await appState.commands.execute('file.open', 'subfolder/doc.md');

        return {
          relativeThrew,
          openedOrigins
        };
      } finally {
        appState.workspace.openFile = originalOpenFile;
      }
    });

    expect(result.relativeThrew).toBe(false);
    expect(result.openedOrigins).toHaveLength(4);
    // Absolute POSIX path converted to FileOrigin
    expect(result.openedOrigins[0]).toEqual({
      scheme: 'file',
      path: '/var/log/app.log',
      name: 'app.log'
    });
    // Windows path converted to FileOrigin
    expect(result.openedOrigins[1]).toEqual({
      scheme: 'file',
      path: 'C:\\Users\\notes\\todo.txt',
      name: 'todo.txt'
    });
    // URI target parsed via parseURI
    expect(result.openedOrigins[2]).toEqual({
      scheme: 'file',
      path: '/etc/hosts',
      name: 'hosts'
    });
    // Rooted path resolved relative to rootOrigin
    expect(result.openedOrigins[3]).toEqual({
      scheme: 'browser',
      path: 'workspace-dir/subfolder/doc.md',
      name: 'doc.md'
    });
  });
});

