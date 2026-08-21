import { readFile, writeFile } from 'node:fs/promises'

async function replace(path, from, to) {
  const source = await readFile(path, 'utf8')
  if (!source.includes(from)) throw new Error(`Missing anchor in ${path}: ${from.slice(0, 100)}`)
  await writeFile(path, source.replace(from, to), 'utf8')
}

await replace(
  'packages/web/src/App.tsx',
  `          blueprints={blueprints}\n          world={activeWorld}`,
  `          blueprints={blueprints}\n          employees={employees}\n          world={activeWorld}`,
)

await replace(
  'packages/web/src/App.tsx',
  `    if (employee.status === 'blocked') return '等待依赖或老板推进'`,
  `    if (employee.status === 'blocked') return '等待依赖或进一步处理'`,
)

await replace(
  'packages/web/src/App.tsx',
  `    if (workspace === undefined) throw new Error('请先创建工作区')\n    const mimeType = attachmentMimeType(file)`,
  `    if (workspace === undefined || activeWorld === undefined) throw new Error('当前世界尚未就绪')\n    const mimeType = attachmentMimeType(file)`,
)

await replace(
  'packages/web/src/App.tsx',
  `    const result = await api<{ attachment: ChatAttachment }>(\`/api/workspaces/${'${workspace.id}'}/assets/attachment\`, {`,
  `    const result = await api<{ attachment: ChatAttachment }>(\`/api/worlds/${'${activeWorld.id}'}/assets/attachment\`, {`,
)

await replace(
  'packages/web/src/App.tsx',
  `  }, [workspace])\n\n  const savePreferences`,
  `  }, [workspace, activeWorld])\n\n  const savePreferences`,
)

await replace(
  'packages/web/src/components/ChatWorkbench.tsx',
  `                  <strong>{owner ? (experience.kind === 'tavern' ? '你' : '老板') : employee?.displayName ?? experience.personLabel}</strong>`,
  `                  <strong>{owner ? '你' : employee?.displayName ?? experience.personLabel}</strong>`,
)

await replace(
  'packages/server/src/server.ts',
  `    const world = store.createWorld({ workspaceId: local.id, name: '我的世界', templateId: 'cyber-company' })`,
  `    const world = store.createWorld({ workspaceId: local.id, name: '我的世界', templateId: 'personal-world' })`,
)

await replace(
  'packages/server/src/server.ts',
  `  const selectedProfileId = request.revision.modelPolicy.modelProfileId\n  const selectedProfile = typeof selectedProfileId === 'string'\n    ? store.getModelProfile(selectedProfileId)\n    : undefined\n  const profile = selectedProfile?.workspaceId === request.agent.workspaceId\n    ? selectedProfile\n    : store.resolveModelProfile(request.agent.workspaceId, request.agent.worldId, request.agent.id)`,
  `  const profile = store.resolveModelProfile(request.agent.workspaceId, request.agent.worldId, request.agent.id)`,
)

await replace(
  'packages/catalog/src/index.ts',
  `export function blueprintsForWorld(templateId: string): EmployeeBlueprint[] {\n  const runtimeTemplateId = templateId === 'personal-world' ? 'cyber-company' : templateId\n  return BUILTIN_BLUEPRINTS.filter((item) => item.worldTemplateId === runtimeTemplateId)\n}`,
  `export function blueprintsForWorld(templateId: string): EmployeeBlueprint[] {\n  return templateId === 'personal-world'\n    ? [...BUILTIN_BLUEPRINTS]\n    : BUILTIN_BLUEPRINTS.filter((item) => item.worldTemplateId === templateId)\n}`,
)

console.log('World experience consistency fixes applied.')
