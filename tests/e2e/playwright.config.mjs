import { defineConfig } from '@playwright/test';
import { PORT, TOKEN } from './env.mjs';

// Starts ZawSQL headless (no app window) with a fixed token. ZAWSQL_CMD overrides the start command,
// e.g. to run a published binary instead of `dotnet run`.
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1360, height: 860 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: process.env.ZAWSQL_CMD
      ?? `dotnet run --project ../../src/ZawSQL -c Release -- --no-browser --port ${PORT} --token ${TOKEN} --config ./.e2e-config`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
