import { expect, type Locator } from '@playwright/test'

export type WorldDockLabel = '世界' | '轨迹' | '角色' | '知识' | '产物' | '日程'

export async function openDockTab(dock: Locator, label: WorldDockLabel): Promise<void> {
  let tab = dock.getByRole('tab', { name: label, exact: true })
  if (await tab.count() === 0) {
    await dock.getByRole('button', { name: '更多', exact: true }).click()
    await dock.getByRole('menuitemcheckbox', { name: label, exact: true }).click()
    tab = dock.getByRole('tab', { name: label, exact: true })
  }
  await expect(tab).toBeVisible()
  await tab.click()
}
