import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

export default defineConfig(base, {
  testMatch: ['chat-draft-isolation.spec.ts'],
  use: { channel: process.env.CI ? 'chromium' : 'chrome' },
})
