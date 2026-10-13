import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  use: {
    baseURL: process.env.E2E_URL ?? 'http://127.0.0.1:3000',
    headless: true,
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
  },
  reporter: 'list',
});
