import type { Page } from '@playwright/test'

/**
 * Records application console failures while excluding Chromium's own
 * headless OpenGL readback diagnostic. The latter is emitted by the CI GPU
 * backend when Playwright captures a WebGL canvas and is not page code.
 */
export function attachAppConsoleRecorder(page: Page, issues: string[]): void {
  page.on('console', (message) => {
    const type = message.type()
    const detail = message.text()
    if ((type === 'error' || type === 'warning') && !isHeadlessGpuReadbackDiagnostic(type, detail)) {
      issues.push(`[console:${type}] ${detail}`)
    }
  })
  page.on('pageerror', (error) => issues.push(`[pageerror] ${error.message}`))
}

function isHeadlessGpuReadbackDiagnostic(type: string, detail: string): boolean {
  return type === 'warning'
    && detail.includes('GL Driver Message')
    && detail.includes('GPU stall due to ReadPixels')
}
