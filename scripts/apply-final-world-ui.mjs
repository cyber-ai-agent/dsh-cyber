import { readFile, writeFile } from 'node:fs/promises'

const path = 'packages/web/src/App.tsx'
let source = await readFile(path, 'utf8')

function replace(from, to, required = true) {
  if (!source.includes(from)) {
    if (required) throw new Error(`Missing App.tsx patch anchor: ${from.slice(0, 120)}`)
    return
  }
  source = source.replace(from, to)
}

replace(
  `    setWorldSettings(settingsResult.settings)\n    setWorldAccess(settingsResult.access)`,
  `    setWorldSettings(settingsResult.settings)\n    applyWorldAppearance(settingsResult.settings)\n    setWorldAccess(settingsResult.access)`,
)

replace(
  `setWorldSettings(result.settings); setReasoningEffort(result.settings.model.reasoningEffort); document.documentElement.style.setProperty('--world-accent', result.settings.appearance.accentColor); document.documentElement.style.setProperty('--world-background', result.settings.appearance.pageBackground); document.documentElement.style.setProperty('--world-character-bubble', result.settings.appearance.characterBubbleColor); document.documentElement.style.setProperty('--world-bubble-radius', \`\${result.settings.appearance.bubbleRadius}px\`)`,
  `setWorldSettings(result.settings); setReasoningEffort(result.settings.model.reasoningEffort); applyWorldAppearance(result.settings)`,
)

replace(
  `function WorldSwitcher({`,
  `function applyWorldAppearance(settings: WorldSettings): void {\n  const root = document.documentElement\n  const appearance = settings.appearance\n  root.style.setProperty('--world-accent', appearance.accentColor)\n  root.style.setProperty('--world-background', appearance.pageBackground)\n  root.style.setProperty('--world-panel', appearance.panelBackground)\n  root.style.setProperty('--world-owner-bubble', appearance.ownerBubbleColor)\n  root.style.setProperty('--world-character-bubble', appearance.characterBubbleColor)\n  root.style.setProperty('--world-text', appearance.textColor)\n  root.style.setProperty('--world-muted', appearance.mutedTextColor)\n  root.style.setProperty('--world-panel-radius', \`\${appearance.panelRadius}px\`)\n  root.style.setProperty('--world-bubble-radius', \`\${appearance.bubbleRadius}px\`)\n  root.style.setProperty('--world-button-radius', \`\${appearance.buttonRadius}px\`)\n  root.style.setProperty('--world-font-scale', String(appearance.fontScale))\n}\n\nfunction WorldSwitcher({`,
)

replace(
  `      const workspaceResult = await api<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '我的本地空间' }) })\n      await api(\`/api/workspaces/\${workspaceResult.workspace.id}/worlds\`, { method: 'POST', body: JSON.stringify({ name: '赛博公司', templateId: 'cyber-company' }) })\n      await onCreated()`,
  `      const workspaceResult = await api<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '本地实例' }) })\n      const worldResult = await api<{ world: World }>(\`/api/workspaces/\${workspaceResult.workspace.id}/worlds\`, { method: 'POST', body: JSON.stringify({ name: '我的世界', templateId: 'personal-world' }) })\n      await api(\`/api/worlds/\${worldResult.world.id}/recruit\`, { method: 'POST', body: JSON.stringify({ blueprintId: 'core.butler', blueprintVersion: 1, displayName: '管家' }) })\n      await onCreated()`,
)

replace(
  `      <p>世界拥有独立角色、会话、记忆和成长档案。不会自动招聘角色。</p>`,
  `      <p>每个世界拥有独立角色、会话、文件、设定和访问锁。首次会添加一名“管家”帮助你开始。</p>`,
)
replace(
  `>{creating ? '正在创建…' : '创建本地工作区'}</button>`,
  `>{creating ? '正在创建…' : '创建我的世界'}</button>`,
)

await writeFile(path, source, 'utf8')

const e2ePath = 'e2e/workbench.spec.ts'
let e2e = await readFile(e2ePath, 'utf8')

function replaceE2E(from, to, required = true) {
  if (!e2e.includes(from)) {
    if (required) throw new Error(`Missing E2E patch anchor: ${from.slice(0, 120)}`)
    return
  }
  e2e = e2e.replace(from, to)
}

// The first-run UI now creates “我的世界” and recruits the built-in 管家.
e2e = e2e.replaceAll("name: '创建本地工作区'", "name: '创建我的世界'")
replaceE2E(
  `  await expect(page.getByRole('heading', { name: '公司还没有角色' })).toBeVisible()\n  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })\n  await expect(composer).toBeDisabled()\n  await expect(composer).toHaveCount(1)\n\n  await page.getByRole('button', { name: '添加第一名角色' }).click()`,
  `  await expect(page.getByRole('button', { name: '与管家私聊' })).toBeVisible()\n  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })\n  await expect(composer).toBeEnabled()\n  await expect(composer).toHaveCount(1)\n\n  await page.getByRole('button', { name: '添加角色' }).click()`,
)

await writeFile(e2ePath, e2e, 'utf8')
