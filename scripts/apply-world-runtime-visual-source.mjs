import { readFile, writeFile } from 'node:fs/promises'

async function patch(path, replacements) {
  let source = await readFile(path, 'utf8')
  for (const [from, to] of replacements) {
    if (!source.includes(from)) throw new Error(`Missing anchor in ${path}: ${from.slice(0, 120)}`)
    source = source.replace(from, to)
  }
  await writeFile(path, source, 'utf8')
}

await patch('packages/server/src/world-runtime-service.ts', [
  [
`    this.#store.saveWorldRuntimeSnapshot(result.snapshot)
    return result.snapshot`,
`    const snapshot = this.#applyCharacterVisuals(result.snapshot)
    this.#store.saveWorldRuntimeSnapshot(snapshot)
    return snapshot`,
  ],
  [
`    this.#store.saveWorldRuntimeSnapshot(result.snapshot)
    return result`,
`    const snapshot = this.#applyCharacterVisuals(result.snapshot)
    this.#store.saveWorldRuntimeSnapshot(snapshot)
    return { ...result, snapshot }`,
  ],
  [
`  async listThemes(worldId: string): Promise<{ activeThemeId: string; items: WorldThemeOption[] }> {`,
`  #applyCharacterVisuals(snapshot: WorldRuntimeSnapshot): WorldRuntimeSnapshot {
    return {
      ...snapshot,
      entities: snapshot.entities.map((entity) => {
        if (entity.kind !== 'agent') return entity
        const profile = this.#store.getEmployeeProfile(entity.id)
        const configured = profile?.appearance['worldSkinIndex'] ?? profile?.appearance['avatarIndex']
        if (typeof configured !== 'number' || !Number.isInteger(configured)) return entity
        const rosterIndex = Math.min(7, Math.max(0, configured))
        return { ...entity, visualState: { ...entity.visualState, rosterIndex } }
      }),
    }
  }

  async listThemes(worldId: string): Promise<{ activeThemeId: string; items: WorldThemeOption[] }> {`,
  ],
])

await patch('packages/web/src/App.tsx', [
  ["<Storefront size={16} />人才市场", "<Storefront size={16} />角色市场"],
])

await patch('packages/web/src/components/SettingsDialog.tsx', [
  ["路由按角色 → 世界 → 工作区逐级继承。", "路由按角色 → 世界 → 全局逐级继承。"],
  ["设为工作区默认模型", "设为全局默认模型"],
  ["label=\"工作区默认\"", "label=\"全局默认\""],
])

console.log('Runtime visual source and product wording aligned.')
