import { expect, type Locator } from '@playwright/test'

/**
 * The trace timeline folds every fact that belongs to one WorkTurn into a
 * single turn card, so an individual `.world-trace-item` starts collapsed
 * inside it. Wait for the fact to arrive, open the owning turn the way a reader
 * does, then open the fact's own «查看过程» disclosure and hand the entry back,
 * so callers keep asserting on the real fact instead of on the group summary.
 */
export async function openTraceEntry(root: Locator, ...texts: string[]): Promise<Locator> {
  const matching = (selector: string): Locator => {
    let locator = root.locator(selector)
    for (const text of texts) locator = locator.filter({ hasText: text })
    return locator
  }
  // Trace entries stream in after the panel opens; count() never waits, so
  // anchor on the fact itself before deciding whether it sits inside a turn.
  await expect(matching('.world-trace-item').first()).toBeAttached()
  const turns = matching('li.world-trace-turn')
  let host = root
  if (await turns.count() > 0) {
    const turn = turns.first()
    if (await turn.locator('> details[open]').count() === 0) await turn.locator('> details > summary').click()
    host = turn
  }
  let entries = host.locator('.world-trace-item')
  for (const text of texts) entries = entries.filter({ hasText: text })
  const entry = entries.first()
  await expect(entry).toBeVisible()
  const disclosure = entry.locator('.world-trace-item__expandable > details:not([open]) > summary')
  if (await disclosure.count() > 0) await disclosure.click()
  return entry
}
