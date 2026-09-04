import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Fail fast: no retries locally or in CI. A red run surfaces the first
  // failure immediately instead of re-running slow editor-ready waits.
  retries: 0,
  // 2 local workers keeps a dev machine usable; CI stays serial.
  workers: process.env.CI ? 1 : 2,
  reporter: 'line',
  // Per-test ceiling is only a backstop for hangs; editor-ready waits fail
  // fast on their own via EDITOR_READY_TIMEOUT (15s). Default assertion timeout
  // remains Playwright's standard 5s so non-editor assertions fail fast.
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    // With retries disabled, retain traces only for failures so a red run
    // still leaves actionable artifacts without per-retry trace overhead.
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'bun run dev:web',
    url: 'http://127.0.0.1:5173',
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
