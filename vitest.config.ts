import { defineConfig } from 'vitest/config'

const shared = {
  testTimeout: 15_000,
  hookTimeout: 15_000,
  // Each project resolves its own root, so the default node_modules exclusion
  // has to be restated or every dependency's tests get collected.
  exclude: ['**/node_modules/**', '**/dist/**', '**/lib/**'],
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'node',
          include: ['packages/**/tests/**/*.test.ts'],
          exclude: [...shared.exclude, 'packages/web/tests/**'],
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
