import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';

test('pane focus hands the DOM focus to the destination editor', async ({ page }) => {
  await mockIconThemes(page);
  await page.goto('/');

  const editor = page.locator('.cm-content').first();
  await expect(editor).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
  await editor.click();

  // Split to the right: the new pane takes the pane focus.
  await page.keyboard.press('Control+k');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-pane-id]')).toHaveCount(2);

  // Put the DOM focus in the editor of the new pane, so the move has
  // somewhere else to come from.
  const editors = page.locator('.cm-content');
  await expect(editors).toHaveCount(2);
  await editors.nth(1).click();

  // Move the pane focus to the left.
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Control+ArrowLeft');

  // The DOM focus followed the pane: it is in the editor of the pane that
  // is active now, not in the one the focus came from.
  const focus = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      inEditor: !!active?.closest('.cm-editor'),
      paneId: active?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null,
      activePaneId: (window as any).appState.workspace.activePaneId,
    };
  });

  expect(focus.activePaneId).toBe(focus.paneId);
  expect(focus.inEditor).toBe(true);
});
