import { test, expect } from '@playwright/test';
import { mockIconThemes } from './helpers/mock-network';
import { EDITOR_READY_TIMEOUT, debugLog, forwardBrowserConsole } from './helpers/e2e-debug';

test('editor should not duplicate text when typing quickly', async ({ page }) => {
  forwardBrowserConsole(page);
  await mockIconThemes(page);
  await page.goto('/');
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });

  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');

  // Type quickly
  await page.keyboard.type('Hello World');
  
  const text = await editor.innerText();
  expect(text.trim()).toBe('Hello World');
});

test('editor should not duplicate text after Enter', async ({ page }) => {
  await mockIconThemes(page);
  await page.goto('/');
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });

  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');

  await page.keyboard.type('Line 1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Line 2');

  const text = await editor.innerText();
  debugLog('Text after Enter:', JSON.stringify(text));
  // Count occurrences of "Line 1"
  const occurrences = (text.match(/Line 1/g) || []).length;
  expect(occurrences).toBe(1);
});
