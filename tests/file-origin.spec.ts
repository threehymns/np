import { test, expect } from '@playwright/test';
import { mockIconThemes } from './helpers/mock-network';

test.describe('FileOrigin & Registry Tests', () => {
  test('toURI and parseURI round-tripping for browser and file schemes', async ({ page }) => {
    await mockIconThemes(page);
    await page.goto('/');

    const roundtripResult = await page.evaluate(async () => {
      // @ts-ignore
      const { toURI, parseURI } = await import('/src/lib/storage.ts');

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

    const registryResult = await page.evaluate(async () => {
      // @ts-ignore
      const { browserHandleRegistry, toURI } = await import('/src/lib/storage.ts');

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
});
