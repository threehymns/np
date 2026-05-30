import { test, expect } from '@playwright/test';
import { mockIconThemes } from './helpers/mock-network';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('vim mode - shift+v paste from end of line without clipboard sync', async ({ page }) => {
  page.on('console', msg => console.log('BROWSER:', msg.type(), msg.text()));
  await mockIconThemes(page);
  await page.goto('/');

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: 30000 });

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
  console.log('Editor text content after Shift+V + p (no clipboard sync):', JSON.stringify(text));

  expect(text).not.toContain('second linep');
  expect(text).toContain('first line\nfirst line');
});

test('vim mode - shift+v followed by p to paste clipboard content (with clipboard sync)', async ({ page, context }) => {
  page.on('console', msg => console.log('BROWSER:', msg.type(), msg.text()));
  await mockIconThemes(page);
  
  // Grant clipboard permissions
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/');

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: 30000 });

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
  console.log('Editor text content after Shift+V + p (clipboard sync):', JSON.stringify(text));

  expect(text).not.toContain('second linep');
  expect(text).toContain('copied from clipboard');
});
