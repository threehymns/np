import { test, expect } from '@playwright/test';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('edit menu items work correctly', async ({ page }) => {
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  // Mock navigator.clipboard to avoid flaky parallel test failures due to browser focus
  await page.addInitScript(() => {
    let clipboardData = '';
    const mockClipboard = {
      writeText: async (text: string) => {
        clipboardData = text;
      },
      readText: async () => {
        return clipboardData;
      }
    };
    try {
      if (navigator.clipboard) {
        navigator.clipboard.writeText = async (text: string) => {
          clipboardData = text;
        };
        navigator.clipboard.readText = async () => {
          return clipboardData;
        };
      }
    } catch (e) {}
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: mockClipboard,
        configurable: true,
        writable: true
      });
    } catch (e) {}
    try {
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        get() {
          return mockClipboard;
        },
        configurable: true
      });
    } catch (e) {}
  });

  await page.goto('/');

  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();

  await editor.click();
  await expect(editor).toBeFocused();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');

  // Type something
  await page.keyboard.type('Hello World');

  // Select All using Edit menu
  await page.click('text=Edit');
  await page.click('text=Select All');


  // Ensure selection is made, we can do this by typing to replace
  // If it's selected, typing 'Replace' will replace 'Hello World'
  await page.keyboard.type('Replaced');

  const textAfterReplace = await editor.innerText();
  expect(textAfterReplace).toContain('Replaced');
  expect(textAfterReplace).not.toContain('Hello World');

  // Undo using Edit menu
  await page.click('text=Edit');
  await page.click('text=Undo');

  const textAfterUndo = await editor.innerText();
  expect(textAfterUndo).toContain('Hello World');
  expect(textAfterUndo).not.toContain('Replaced');
  
  // Select All and Copy
  await page.click('text=Edit');
  await page.click('text=Select All');
  
  await page.click('text=Edit');

  await page.click('text=Copy');
  
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());

  
  // Go to end and paste
  await editor.click(); // removes selection
  await expect(editor).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  
  await page.click('text=Edit');
  await page.click('text=Paste');
  
  const textAfterPaste = await editor.innerText();
  expect(textAfterPaste).toContain('Hello World\nHello World');
});