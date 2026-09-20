import { expect, type Page } from '@playwright/test'

/** Open the same visible global tool entry used by people. */
export async function openGlobalTool(page: Page, name: string | RegExp) {
  const entry = page.getByRole('button', { name, ...(typeof name === 'string' ? { exact: true } : {}) })
  if (!await entry.isVisible()) {
    const tools = page.getByRole('button', { name: '工具', exact: true })
    await expect(tools).toBeVisible(); await tools.click()
  }
  await expect(entry).toBeVisible(); await expect(entry).toBeEnabled(); await entry.click()
}
