import { test, expect } from '@playwright/test';
import { mockIconThemes } from './helpers/mock-network';

test('WhichKey should open immediately on space', async ({ page }) => {
  page.on('console', msg => console.log('BROWSER:', msg.text()));
  await mockIconThemes(page);
  await page.goto('/');

  // Target the CodeMirror editor
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: 30000 });

  // Focus the editor
  await editor.click();

  // Enable Vim mode via preferences if possible, or just mock it.
  // Actually, we can use the Command Palette to enable it if we have a command for it.
  // Or just set it in localStorage before goto.
  await page.evaluate(() => {
    localStorage.setItem('np-prefs-v2', JSON.stringify({ vimMode: true }));
  });
  await page.reload();
  await expect(editor).toBeVisible();
  await editor.click();

  // Press space
  await page.keyboard.press(' ');

  // WhichKey panel should be visible
  const whichKey = page.locator('.whichkey-panel');
  await expect(whichKey).toBeVisible();

  // It should show options (e.g. "f" for file)
  const fileOption = whichKey.locator('text=file');
  await expect(fileOption).toBeVisible();

  // Escape to close
  await page.keyboard.press('Escape');
  await expect(whichKey).not.toBeVisible();

  // Press Cmd+K (Ctrl+K on Linux)
  await page.keyboard.press('Control+k');

  // WhichKey panel should be visible
  await expect(whichKey).toBeVisible();
  
  // It should show options (e.g. "change language mode")
  const langOption = whichKey.locator('text=Change Language Mode');
  await expect(langOption).toBeVisible();

  // Backspace to go back to leader
  await page.keyboard.press('Backspace');
  // Since we started with cmd+k, backspace should clear the buffer and WhichKey should close (or show top level if top level had partial matches).
  // In this case, cmd+k has no other siblings, so backspace should close it.
  await expect(whichKey).not.toBeVisible();

  // Test space f -> Backspace
  await page.keyboard.press(' ');
  await expect(whichKey).toBeVisible();
  await page.keyboard.press('f');
  await expect(whichKey.locator('text=New')).toBeVisible();
  await page.keyboard.press('Backspace');
  await expect(whichKey.locator('text=file')).toBeVisible();
});
