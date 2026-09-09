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
    // Vitest defaults to `availableParallelism() - 1` fork workers per project.
    // On a 24-core developer machine that is 23 Node child processes per
    // project (46 across both), each holding its own module graph; the
    // resulting temp-directory churn has already cost one full run to ENOSPC.
    // The cap is per project, so 4 + 4 keeps the whole suite at eight fork
    // workers without giving up file-level parallelism.
    maxWorkers: 4,
    projects: [
      {
        test: {
          ...shared,
          name: 'node',
          include: ['packages/**/tests/**/*.test.ts', 'packages/**/tests/**/*.test.tsx'],
          exclude: [...shared.exclude, 'packages/web/tests/**'],
        },
      },
      {
        test: {
          ...shared,
          name: 'web',
          include: ['packages/web/tests/**/*.test.ts', 'packages/web/tests/**/*.test.tsx'],
          setupFiles: ['packages/web/tests/setup.ts'],
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
