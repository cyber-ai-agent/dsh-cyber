import { expect, type Locator } from '@playwright/test'

/**
 * The trace timeline folds every fact that belongs to one WorkTurn into a
 * single turn card, so an individual `.world-trace-item` starts collapsed
 * inside it. Open the owning turn the way a reader does, then open the fact's
 * own «查看过程» disclosure and hand the entry back so callers keep asserting
 * on the real fact instead of on the group summary.
 */
export async function openTraceEntry(root: Locator, ...texts: string[]): Promise<Locator> {
  let turns = root.locator('li.world-trace-turn')
  for (const text of texts) turns = turns.filter({ hasText: text })
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
