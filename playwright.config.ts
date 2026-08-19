import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  outputDir: '.private/playwright-results',
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1_584, height: 992 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
})
