import { test, expect } from '@playwright/test';
import { mockIconThemes } from './helpers/mock-network';
import { EDITOR_READY_TIMEOUT, debugLog, forwardBrowserConsole } from './helpers/e2e-debug';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('vim mode - shift+v paste from end of line without clipboard sync', async ({ page }) => {
  forwardBrowserConsole(page);
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
  debugLog('Editor text content after Shift+V + p (no clipboard sync):', JSON.stringify(text));

  expect(text).not.toContain('second linep');
  expect(text).toContain('first line\nfirst line');
});

test('vim mode - shift+v followed by p to paste clipboard content (with clipboard sync)', async ({ page, context }) => {
  forwardBrowserConsole(page);
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
  debugLog('Editor text content after Shift+V + p (clipboard sync):', JSON.stringify(text));

  expect(text).not.toContain('second linep');
  expect(text).toContain('copied from clipboard');
});

test('vim mode - WhichKey support', async ({ page }) => {
  forwardBrowserConsole(page);
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

