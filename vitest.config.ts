import { defineConfig } from 'vitest/config'

const shared = {
  testTimeout: 15_000,
  hookTimeout: 15_000,
  // Each project resolves its own root, so the default node_modules exclusion
  // has to be restated or every dependency's tests get collected.
  exclude: ['**/node_modules/**', '**/dist/**', '**/lib/**'],
}

const approvalIntegrationPath = 'packages/server/tests/group-skill-approval-continuation.test.ts'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          // This file exercises multiple durable queue / approval transitions,
          // including continuation and restart recovery. Keep the normal Node
          // suite strict; only let this integration file's own 30s diagnostic
          // deadline fire first on a contended GitHub runner.
          testTimeout: process.env.CI ? 35_000 : shared.testTimeout,
          name: 'node-approval-integration',
          include: [approvalIntegrationPath],
        },
      },
      {
        test: {
          ...shared,
          name: 'node',
          include: ['packages/**/tests/**/*.test.ts'],
          exclude: [...shared.exclude, 'packages/web/tests/**', approvalIntegrationPath],
        },
      },
      {
        test: {
          ...shared,
          name: 'web',
          include: ['packages/web/tests/**/*.test.ts'],
          // Web tests render into a real DOM so effects, subscriptions and
          // event listeners actually run. Without it every web test was a
          // static-markup snapshot: a client crash on first subscribe passed
          // 443 unit tests and only surfaced when the browser suite ran.
          environment: 'happy-dom',
        },
      },
    ],
  },
})
