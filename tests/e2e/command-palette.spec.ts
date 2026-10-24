import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';

/**
 * The pane commands are titled for their feature ("Pane: Split Right"), the
 * way the Git ones are ("Git: Stage File"), and they carry "pane" as a
 * keyword, so the palette answers to the word as well as to the title.
 */
test('Command palette finds the split commands by the word "pane"', async ({ page }) => {
  await mockIconThemes(page);
  await page.goto('/');

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });

  await page.keyboard.press('Control+Shift+P');

  const input = page.locator('[data-slot="command-input"]');
  await expect(input).toBeVisible();
  await input.fill('pane');

  await expect(page.getByText('Pane: Split Right', { exact: true })).toBeVisible();
  await expect(page.getByText('Pane: Split Down', { exact: true })).toBeVisible();
  await expect(page.getByText('Pane: Focus Left', { exact: true })).toBeVisible();

  // A command that does not answer to "pane" is filtered out.
  await expect(page.getByText('Bold', { exact: true })).not.toBeVisible();
});

test('Command palette still finds the split commands by their direction', async ({ page }) => {
  await mockIconThemes(page);
  await page.goto('/');

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });

  await page.keyboard.press('Control+Shift+P');

  const input = page.locator('[data-slot="command-input"]');
  await expect(input).toBeVisible();
  await input.fill('split right');

  await expect(page.getByText('Pane: Split Right', { exact: true })).toBeVisible();
});
