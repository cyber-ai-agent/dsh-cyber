import { readFile, writeFile } from 'node:fs/promises'

async function patchFile(path, patches) {
  let value = await readFile(path, 'utf8')
  for (const [from, to, required = true] of patches) {
    if (!value.includes(from)) {
      if (required) throw new Error(`Missing patch anchor in ${path}: ${String(from).slice(0, 120)}`)
      continue
    }
    value = value.replace(from, to)
  }
  await writeFile(path, value, 'utf8')
}

await patchFile('packages/web/src/App.tsx', [
  [
    `    setWorldSettings(settingsResult.settings)\n    setWorldAccess(settingsResult.access)`,
    `    setWorldSettings(settingsResult.settings)\n    applyWorldAppearance(settingsResult.settings)\n    setWorldAccess(settingsResult.access)`,
  ],
  [
    `setWorldSettings(result.settings); setReasoningEffort(result.settings.model.reasoningEffort); document.documentElement.style.setProperty('--world-accent', result.settings.appearance.accentColor); document.documentElement.style.setProperty('--world-background', result.settings.appearance.pageBackground); document.documentElement.style.setProperty('--world-character-bubble', result.settings.appearance.characterBubbleColor); document.documentElement.style.setProperty('--world-bubble-radius', \`\${result.settings.appearance.bubbleRadius}px\`)`,
    `setWorldSettings(result.settings); setReasoningEffort(result.settings.model.reasoningEffort); applyWorldAppearance(result.settings)`,
  ],
  [
    `function WorldSwitcher({`,
    `function applyWorldAppearance(settings: WorldSettings): void {\n  const root = document.documentElement\n  const appearance = settings.appearance\n  root.style.setProperty('--world-accent', appearance.accentColor)\n  root.style.setProperty('--world-background', appearance.pageBackground)\n  root.style.setProperty('--world-panel', appearance.panelBackground)\n  root.style.setProperty('--world-owner-bubble', appearance.ownerBubbleColor)\n  root.style.setProperty('--world-character-bubble', appearance.characterBubbleColor)\n  root.style.setProperty('--world-text', appearance.textColor)\n  root.style.setProperty('--world-muted', appearance.mutedTextColor)\n  root.style.setProperty('--world-panel-radius', \`\${appearance.panelRadius}px\`)\n  root.style.setProperty('--world-bubble-radius', \`\${appearance.bubbleRadius}px\`)\n  root.style.setProperty('--world-button-radius', \`\${appearance.buttonRadius}px\`)\n  root.style.setProperty('--world-font-scale', String(appearance.fontScale))\n}\n\nfunction WorldSwitcher({`,
  ],
  [
    `      const workspaceResult = await api<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '我的本地空间' }) })\n      await api(\`/api/workspaces/\${workspaceResult.workspace.id}/worlds\`, { method: 'POST', body: JSON.stringify({ name: '赛博公司', templateId: 'cyber-company' }) })\n      await onCreated()`,
    `      const workspaceResult = await api<{ workspace: Workspace }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: '本地实例' }) })\n      const worldResult = await api<{ world: World }>(\`/api/workspaces/\${workspaceResult.workspace.id}/worlds\`, { method: 'POST', body: JSON.stringify({ name: '我的世界', templateId: 'personal-world' }) })\n      await api(\`/api/worlds/\${worldResult.world.id}/recruit\`, { method: 'POST', body: JSON.stringify({ blueprintId: 'core.butler', blueprintVersion: 1, displayName: '管家' }) })\n      await onCreated()`,
  ],
  [
    `      <p>世界拥有独立角色、会话、记忆和成长档案。不会自动招聘角色。</p>`,
    `      <p>每个世界拥有独立角色、会话、文件、设定和访问锁。首次会添加一名“管家”帮助你开始。</p>`,
  ],
  [
    `>{creating ? '正在创建…' : '创建本地工作区'}</button>`,
    `>{creating ? '正在创建…' : '创建我的世界'}</button>`,
  ],
])

await patchFile('e2e/workbench.spec.ts', [
  ["name: '创建本地工作区'", "name: '创建我的世界'"],
  ["name: '创建本地工作区'", "name: '创建我的世界'", false],
  [
    `  await expect(page.getByRole('heading', { name: '公司还没有角色' })).toBeVisible()\n  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })\n  await expect(composer).toBeDisabled()\n  await expect(composer).toHaveCount(1)\n\n  await page.getByRole('button', { name: '添加第一名角色' }).click()`,
    `  await expect(page.getByRole('button', { name: '与管家私聊' })).toBeVisible()\n  const composer = page.getByRole('textbox', { name: '给当前世界的角色发送消息' })\n  await expect(composer).toBeEnabled()\n  await expect(composer).toHaveCount(1)\n\n  await page.locator('.left-pane').getByRole('button', { name: '添加角色' }).click()`,
  ],
])

// Keep personal-world as a first-class persisted world id. Do not rewrite it to company.
await patchFile('packages/server/src/routes/world-routes.ts', [
  [
    `    const templateId = requestedTemplateId === 'personal-world' ? 'cyber-company' : requestedTemplateId\n    const world = store.createWorld({\n      workspaceId: params[0]!,\n      name: requiredString(body, 'name'),\n      templateId,\n    })\n    writeJson(response, 201, { world, requestedTemplateId })`,
    `    const world = store.createWorld({\n      workspaceId: params[0]!,\n      name: requiredString(body, 'name'),\n      templateId: requestedTemplateId,\n    })\n    writeJson(response, 201, { world })`,
  ],
])

// A personal world is intentionally generic: it can recruit built-in or package roles from other templates.
await patchFile('packages/server/src/routes/catalog-routes.ts', [
  [
    `    const runtimeTemplateId = templateId === 'personal-world' ? 'cyber-company' : templateId\n`,
    ``,
  ],
  [
    `    const items = runtimeTemplateId\n      ? available.filter((item) => item.worldTemplateId === runtimeTemplateId)\n      : available`,
    `    const items = templateId === 'personal-world'\n      ? available\n      : templateId\n        ? available.filter((item) => item.worldTemplateId === templateId)\n        : available`,
  ],
])

// Preserve strict template isolation everywhere except the explicitly generic personal world.
await patchFile('packages/persistence/src/sqlite-store.ts', [
  [
    `    if (blueprint.worldTemplateId !== world.templateId) {\n      throw new PersistenceError(\n        \`Blueprint \${blueprint.id}@\${blueprint.version} belongs to \${blueprint.worldTemplateId}, not \${world.templateId}\`,\n      )\n    }`,
    `    if (blueprint.worldTemplateId !== world.templateId && world.templateId !== 'personal-world') {\n      throw new PersistenceError(\n        \`Blueprint \${blueprint.id}@\${blueprint.version} belongs to \${blueprint.worldTemplateId}, not \${world.templateId}\`,\n      )\n    }`,
  ],
])

// Personal worlds use the mature Pixi company scene as their built-in visual fallback,
// while keeping their own template identity and remaining replaceable by installed themes.
await patchFile('packages/server/src/world-runtime-service.ts', [
  [
    `  #manifestForTemplate(templateId: string): WorldThemeManifestV1 | undefined {\n    if (templateId === 'company' || templateId === 'cyber-company') return cyberCompanyTheme`,
    `  #manifestForTemplate(templateId: string): WorldThemeManifestV1 | undefined {\n    if (templateId === 'personal-world') {\n      return {\n        ...cyberCompanyTheme,\n        id: 'dsh-cyber.personal.default',\n        version: '1.0.0',\n        templateId: 'personal-world',\n        displayName: '我的世界 · 默认空间',\n        terminology: {\n          ...cyberCompanyTheme.terminology,\n          world: '世界',\n          participant: '角色',\n          session: '会话',\n          milestone: '成长记录',\n        },\n      }\n    }\n    if (templateId === 'company' || templateId === 'cyber-company') return cyberCompanyTheme`,
  ],
  [
    `function themeTemplateMatches(worldTemplateId: string, themeTemplateId: string): boolean {\n  if (worldTemplateId === themeTemplateId) return true`,
    `function themeTemplateMatches(worldTemplateId: string, themeTemplateId: string): boolean {\n  if (worldTemplateId === 'personal-world') return true\n  if (worldTemplateId === themeTemplateId) return true`,
  ],
])
