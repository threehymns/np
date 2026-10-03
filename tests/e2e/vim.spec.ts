import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';
import { installMockFS } from './helpers/mock-fs';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('vim mode - shift+v paste from end of line without clipboard sync', async ({ page }) => {
  await mockIconThemes(page);
  await page.goto('/');

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });

  // Focus and clear
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');

  // Enable Vim Mode via window.appState
  await page.evaluate(() => {
    (window as any).appState.prefs.vimMode = true;
    (window as any).appState.prefs.vimSyncClipboard = false;
  });

  // Type some text
  await page.keyboard.press('i');
  await page.keyboard.type('first line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second line');
  await page.keyboard.press('Escape');

  // Ensure cursor is at the top line (gg)
  await page.keyboard.type('gg');

  // Yank the first line (yy)
  await page.keyboard.type('yy');

  // Move down to the second line (j)
  await page.keyboard.type('j');

  // Move to the end of the second line ($)
  await page.keyboard.type('$');

  // Enter Visual Line mode (Shift+V)
  await page.keyboard.press('Shift+V');

  // Press p to paste
  await page.keyboard.press('p');

  // Get the text content of the editor
  const text = await editor.innerText();

  expect(text).not.toContain('second linep');
  expect(text).toContain('first line\nfirst line');
});

test('vim mode - shift+v followed by p to paste clipboard content (with clipboard sync)', async ({ page, context }) => {
  await mockIconThemes(page);
  
  // Grant clipboard permissions
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/');

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });

  // Focus and clear
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');

  // Enable Vim Mode via window.appState
  await page.evaluate(() => {
    (window as any).appState.prefs.vimMode = true;
    (window as any).appState.prefs.vimSyncClipboard = true;
  });

  // Set clipboard content
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('copied from clipboard');
  });

  // Type some text
  await page.keyboard.press('i');
  await page.keyboard.type('first line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second line');
  await page.keyboard.press('Escape');

  // Ensure cursor is on the second line
  await page.keyboard.type('j');

  // Enter Visual Line mode (Shift+V)
  await page.keyboard.press('Shift+V');

  // Wait a short moment to make sure selection event updates if any
  await page.waitForTimeout(100);

  // Press p to paste
  await page.keyboard.press('p');

  // Get the text content of the editor
  const text = await editor.innerText();

  expect(text).not.toContain('second linep');
  expect(text).toContain('copied from clipboard');
});

test('vim mode - ctrl+space summons buffer-word completions in insert mode', async ({ page }) => {
  await mockIconThemes(page);
  await page.goto('/');

  const editor = page.locator('.cm-content').first();
  await expect(editor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
  await page.waitForFunction(() => typeof (window as any).appState !== 'undefined' && typeof (window as any).browserHandleRegistry !== 'undefined');
  await page.evaluate(installMockFS);

  // A Markdown file, so the language compartment gives the buffer-word chain a
  // language to attach to.
  await page.evaluate(async () => {
    const appState = (window as any).appState;
    const note = new (window as any).MockFileHandle('Words.md', new TextEncoder().encode(''));
    await (window as any).browserHandleRegistry.register('browser://Words.md', note);
    await appState.workspace.openFile({ scheme: 'browser', path: 'Words.md', name: 'Words.md' });
  });

  const active = page.locator('.cm-content').first();
  await expect(active).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });

  await page.evaluate(() => {
    (window as any).appState.prefs.vimMode = true;
  });

  // Wait for Svelte effects and the vim compartment reconfiguration to settle.
  await page.waitForTimeout(500);

  await active.focus();

  // Insert mode: the buffer vocabulary is the text typed before the cursor.
  await page.keyboard.press('i');
  await page.keyboard.type('kettle whistles');
  await page.keyboard.press('Enter');
  await page.keyboard.type('kettl');

  // The explicit trigger must reach the popover without leaving insert mode.
  await page.keyboard.press('Control+Space');

  const tooltip = page.locator('.cm-tooltip-autocomplete').first();
  await expect(tooltip).toBeVisible({ timeout: 5000 });
  await expect(tooltip).toContainText('kettle');

  // Still insert mode: the modal binding never fought the completion.
  const docText = await page.evaluate(() =>
    (window as any).appState.activeEditorView.state.doc.toString()
  );
  expect(docText).toBe('kettle whistles\nkettl');
});

test('vim mode - WhichKey support', async ({ page }) => {
  await mockIconThemes(page);
  await page.goto('/');

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });

  // Enable Vim Mode via window.appState
  await page.evaluate(() => {
    (window as any).appState.prefs.vimMode = true;
  });

  // Wait for Svelte effects and CodeMirror reconfiguration to settle
  await page.waitForTimeout(500);

  // Focus editor
  await editor.focus();
  await editor.click();

  // Type some text and escape to normal mode to ensure CodeMirror-Vim has text/state
  await page.keyboard.press('i');
  await page.keyboard.type('test');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);

  // Press Space (Vim Leader key)
  await page.keyboard.press('Space');

  // Verify WhichKey panel is visible
  const panel = page.locator('.whichkey-panel');
  await expect(panel).toBeVisible();

  // Verify it shows "Leader"
  const title = page.locator('.whichkey-title');
  await expect(title).toHaveText('Leader');

  // Press 'f' to go into the File subgroup
  await page.keyboard.press('f');

  // Verify it shows "Leader ➔ file"
  await expect(title).toHaveText('Leader ➔ file');

  // Click the "New" option in WhichKey panel
  const newFileBtn = page.locator('.whichkey-item', { hasText: 'New' });
  await expect(newFileBtn).toBeVisible();
  await newFileBtn.click();

  // Verify panel is hidden
  await expect(panel).not.toBeVisible();

  // Verify that a new file was created
  const docCount = await page.evaluate(() => (window as any).appState.documents.length);
  expect(docCount).toBe(2);
});

