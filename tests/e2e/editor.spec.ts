import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';

test('editor should correctly handle markdown syntax', async ({ page }) => {
  await mockIconThemes(page);
  await page.goto('/');

  // Target the CodeMirror editor
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });

  // The language is resolved from the file name. An untitled document has no
  // extension, so it is plain text and the Markdown rules never run. Switch
  // the document to Markdown before typing into it.
  await page.evaluate(() => {
    (window as any).appState.activeDocument.userLanguageOverride = 'Markdown';
  });
  await expect(page.locator('button:has-text("Markdown")')).toBeVisible();

  // Focus and clear
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');

  // Type Markdown content
  await page.keyboard.type('# Heading 1');
  // It should be visible while we are on the line
  let text = await editor.innerText();
  expect(text).toContain('# Heading 1');

  await page.keyboard.press('Enter');
  // Now it should be hidden
  text = await editor.innerText();
  expect(text).not.toContain('# ');
  expect(text).toContain('Heading 1');
  
  await page.keyboard.type('**Bold Text**');
  // Visible while on the line
  text = await editor.innerText();
  expect(text).toContain('**Bold Text**');

  await page.keyboard.press('Enter');
  // Now it should be hidden
  text = await editor.innerText();
  expect(text).not.toContain('**');
  expect(text).toContain('Bold Text');
  
  await page.keyboard.type('- List Item 1');
  // The cursor has moved past the marker, so the marker is replaced by a bullet
  text = await editor.innerText();
  expect(text).toContain('• List Item 1');
  expect(text).not.toContain('- List Item 1');
});
