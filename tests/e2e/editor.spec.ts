import { test, expect } from '@playwright/test';
import { mockIconThemes } from './helpers/mock-network';
import { EDITOR_READY_TIMEOUT, forwardBrowserConsole } from './helpers/e2e-debug';

test('editor should correctly handle markdown syntax', async ({ page }) => {
  forwardBrowserConsole(page);
  await mockIconThemes(page);
  await page.goto('/');

  // Target the CodeMirror editor
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });

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
  // Visible while on the line
  text = await editor.innerText();
  expect(text).toContain('- List Item 1');
});
