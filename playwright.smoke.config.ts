import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

export default defineConfig(base, {
  testMatch: ['chat-draft-isolation.spec.ts', 'trace-evidence.spec.ts', 'model-stats.spec.ts', 'runtime-reconnect.spec.ts', 'source-task-completion.spec.ts', 'conversation-task-intent.spec.ts', 'task-cancel.spec.ts'],
  use: { channel: process.env.CI ? 'chromium' : 'chrome' },
})
