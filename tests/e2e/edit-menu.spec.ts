import type { Page } from '@playwright/test';
import { test, expect, EDITOR_READY_TIMEOUT } from './helpers/e2e-debug';
import { mockIconThemes } from './helpers/mock-network';

const hamburger = (page: Page) => page.getByRole('button', { name: 'Application menu', exact: true });
const category = (page: Page, name: string) => page.getByRole('menubar').getByRole('menuitem', { name, exact: true });
const item = (page: Page, name: string) => page.getByRole('menuitem', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$| CTRL\\+)`) });
const editor = (page: Page) => page.getByRole('region', { name: 'Code Editor' }).getByRole('textbox');

async function openCategory(page: Page, name: string) {
  await hamburger(page).click();
  await category(page, name).hover();
  await expect(category(page, name)).toHaveAttribute('aria-expanded', 'true');
}

test.beforeEach(async ({ page }) => {
  await mockIconThemes(page);
  await page.addInitScript(() => {
    let text = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => { text = value; },
        readText: async () => text
      }
    });
  });
  await page.goto('/');
  await expect(editor(page)).toBeVisible({ timeout: EDITOR_READY_TIMEOUT });
});

test('compact menu opens File immediately and switches categories by pointer', async ({ page }) => {
  await expect(hamburger(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('menubar')).toBeHidden();
  const top = (await editor(page).boundingBox())!.y;
  await hamburger(page).click();
  await expect(category(page, 'File')).toHaveAttribute('aria-expanded', 'true');
  await expect(item(page, 'New')).toBeVisible();
  await expect(page.getByRole('menubar').getByRole('menuitem')).toHaveText(['File', 'Edit', 'Format', 'View']);
  expect((await editor(page).boundingBox())!.y).toBe(top);
  for (const [name, command] of [['Edit', 'Select All'], ['Format', 'Bold'], ['View', 'Zoom'], ['File', 'Export']]) {
    await category(page, name).hover();
    await expect(category(page, name)).toHaveAttribute('aria-expanded', 'true');
    await expect(item(page, command)).toBeVisible();
    await expect(hamburger(page)).toBeHidden();
  }
  await editor(page).click();
  await expect(hamburger(page)).toBeVisible();
  await expect(editor(page)).toBeFocused();
});

test('F10 toggles once, arrows wrap, Escape and Tab restore hamburger focus', async ({ page }) => {
  await editor(page).click();
  await page.keyboard.press('F10');
  await expect(category(page, 'File')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(category(page, 'View')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(category(page, 'Format')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(category(page, 'View')).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('menuitemcheckbox', { name: /Status Bar/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(category(page, 'File')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(hamburger(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(item(page, 'New')).toBeVisible();
  await page.keyboard.press('F10');
  await expect(hamburger(page)).toBeFocused();
  await page.keyboard.press('F10');
  await page.keyboard.press('Tab');
  await expect(hamburger(page)).toBeFocused();
  await page.keyboard.press('Alt');
  await expect(page.getByRole('menubar')).toBeHidden();
});

test('nested Export and Zoom dismiss one level and preserve expanded categories', async ({ page }) => {
  await hamburger(page).click();
  await item(page, 'Export').hover();
  await expect(item(page, 'Copy as HTML')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(item(page, 'Copy as HTML')).toBeHidden();
  await expect(item(page, 'Export')).toBeVisible();
  await expect(hamburger(page)).toBeHidden();
  await category(page, 'View').hover();
  await expect(category(page, 'View')).toHaveAttribute('aria-expanded', 'true');
  await item(page, 'Zoom').focus();
  await page.keyboard.press('Enter');
  await expect(item(page, 'Zoom In')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(item(page, 'Zoom In')).toBeHidden();
  await expect(item(page, 'Zoom')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(item(page, 'Zoom In')).toBeVisible();
  await item(page, 'Zoom In').focus();
  await page.keyboard.press('ArrowRight');
  await expect(category(page, 'File')).toHaveAttribute('aria-expanded', 'true');
  await expect(item(page, 'New')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(hamburger(page)).toBeFocused();
});

test('edit commands preserve selection and return focus to the active editor', async ({ page }) => {
  await editor(page).click();
  await page.keyboard.type('Hello World');
  await openCategory(page, 'Edit');
  await item(page, 'Select All').click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('Replaced');
  await expect(editor(page)).toHaveText('Replaced');
  await openCategory(page, 'Edit');
  await item(page, 'Undo').click();
  await expect(editor(page)).toHaveText('Hello World');
  await openCategory(page, 'Edit');
  await item(page, 'Select All').click();
  await expect(editor(page)).toBeFocused();
  await openCategory(page, 'Edit');
  await item(page, 'Copy').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Hello World');
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await openCategory(page, 'Edit');
  await item(page, 'Paste').click();
  await expect(editor(page)).toHaveText('Hello World\nHello World', { useInnerText: true });
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await openCategory(page, 'Edit');
  await item(page, 'Cut').click();
  await expect(editor(page)).toHaveText('Hello World\n', { useInnerText: true });
  await expect(editor(page)).toBeFocused();
});

test('format commands act on selected text after keyboard menu navigation', async ({ page }) => {
  await editor(page).click();
  await page.keyboard.type('one two');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('F10');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await item(page, 'Bold').focus();
  await page.keyboard.press('Enter');
  await expect(editor(page)).toHaveText('**one** two');
  await expect(editor(page)).toBeFocused();
});

test('checkboxes, shortcuts, settings and disabled commands remain available', async ({ page }) => {
  await openCategory(page, 'Format');
  const wrap = page.getByRole('menuitemcheckbox', { name: /Word Wrap/ });
  const checked = await wrap.getAttribute('aria-checked');
  await wrap.click();
  await openCategory(page, 'Format');
  await expect(wrap).toHaveAttribute('aria-checked', checked === 'true' ? 'false' : 'true');
  await category(page, 'View').hover();
  await expect(page.getByRole('menuitemcheckbox', { name: /Status Bar/ })).toBeChecked();
  await expect(page.getByRole('menuitemcheckbox', { name: /Sidebar/ })).toBeVisible();
  await category(page, 'Edit').hover();
  await expect(page.getByRole('menuitem', { name: /Settings\.\.\./ })).toContainText('CTRL+,');
  await expect(item(page, 'Open Settings (JSON)')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor(page)).toBeVisible();
  await openCategory(page, 'Edit');
  await expect(page.getByRole('menuitem', { name: /^Undo/ })).toBeEnabled();
  await category(page, 'Format').hover();
  await expect(page.getByRole('menuitem', { name: /^Bold/ })).toBeEnabled();
});

test('expanded header and nested menus fit a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await hamburger(page).click();
  for (const name of ['File', 'Edit', 'Format', 'View']) {
    await category(page, name).hover();
    await expect(category(page, name)).toBeInViewport();
    for (const menu of await page.getByRole('menu').all()) {
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320);
    }
  }
  await item(page, 'Zoom').hover();
  await expect(item(page, 'Zoom In')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
