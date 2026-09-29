import { defineConfig } from '@playwright/test';

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
  },
  webServer: {
    command: `pnpm --filter @systemsage/web exec next dev -p ${PORT}`,
    url: BASE_URL,
    cwd: '..',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
