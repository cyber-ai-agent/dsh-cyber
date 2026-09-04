import fs from 'node:fs'
const { chromium } = await import('playwright')
const notes = []
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 130)))
try {
  await page.goto('http://127.0.0.1:43123', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('header nav button', { timeout: 20000 })
  await page.getByRole('button', { name: /模型中心/ }).click()
  await page.waitForSelector('.model-hub', { timeout: 15000 })
  await page.getByRole('button', { name: '模型设置' }).click()
  await page.waitForSelector('.model-hub__assign', { timeout: 8000 })
  // 左栏：全局 + 世界
  const rail = await page.$$eval('.model-hub__assign-targets button', (els) => els.map((e) => e.querySelector('strong')?.textContent?.trim()))
  notes.push('全局视图行: ' + JSON.stringify(rail))
  // 下拉切到赛博公司 → 列本世界+角色
  const scopeSel = page.locator('.model-hub__assign-scope select')
  const opts = await scopeSel.locator('option').allTextContents()
  notes.push('范围下拉: ' + JSON.stringify(opts))
  await scopeSel.selectOption({ label: '赛博公司' })
  await page.waitForTimeout(300)
  const rail2 = await page.$$eval('.model-hub__assign-targets button strong', (els) => els.map((e) => e.textContent?.trim()))
  notes.push('世界视图行: ' + JSON.stringify(rail2))
  // 选中"本世界"行，中间点 agnes 服务商
  await page.locator('.model-hub__assign-targets button').first().click()
  await page.locator('.model-hub__assign-providers button', { hasText: 'agnes' }).click()
  await page.waitForTimeout(300)
  const models = await page.$$eval('.model-hub__assign-table tbody tr', (els) => els.map((tr) => tr.querySelector('strong')?.textContent?.trim()).slice(0, 4))
  const applyBtns = await page.locator('.model-hub__assign-table button', { hasText: '应用' }).count()
  notes.push('agnes 模型行: ' + JSON.stringify(models) + ' 应用按钮=' + applyBtns)
  // 应用到本世界（临时写入，稍后清除恢复）
  await page.locator('.model-hub__assign-table tr', { hasText: 'agnes-2.5-flash' }).locator('button', { hasText: '应用' }).first().click()
  await page.waitForTimeout(1200)
  const rowState = await page.$$eval('.model-hub__assign-table tr.is-current', (els) => els.map((e) => e.querySelector('strong')?.textContent?.trim()))
  const targetHint = await page.$eval('.model-hub__assign-current, .model-hub__assign-none', (e) => e.textContent?.trim())
  const note = await page.$eval('.model-hub__assign-note', (e) => e.textContent?.trim())
  notes.push('应用后 高亮行=' + JSON.stringify(rowState) + ' 左栏徽章=' + targetHint + ' 底注=' + note)
  await page.screenshot({ path: 'G:/harness/dsh-cyber/.private/ui-fix-verification/hub-assign-applied.png' })
  // 清除恢复原状
  await page.locator('.model-hub__assign-table tr.is-current').locator('button', { hasText: '清除' }).click()
  await page.waitForTimeout(1200)
  notes.push('清除后 高亮行数=' + await page.locator('.model-hub__assign-table tr.is-current').count() + ' 底注=' + await page.$eval('.model-hub__assign-note', (e) => e.textContent?.trim()))
} catch (e) { notes.push('SCRIPT-FAIL ' + String(e).slice(0, 160)) }
notes.push('errors=' + errors.length + (errors.length ? ' | ' + errors[0] : ''))
fs.writeFileSync('G:/harness/dsh-cyber/.private/ui-fix-verification/hub-assign-notes.log', notes.join('\n'))
console.log(notes.join('\n'))
await browser.close()
