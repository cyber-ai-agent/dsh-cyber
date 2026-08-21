import { readFile, writeFile } from 'node:fs/promises'

async function mutate(path, transform) {
  const source = await readFile(path, 'utf8')
  const next = transform(source)
  if (next === source) throw new Error(`No change produced for ${path}`)
  await writeFile(path, next, 'utf8')
}

await mutate('e2e/workbench.spec.ts', (source) => source
  .replaceAll('角色称呼（可选）', '角色名字（可选）')
  .replaceAll("name: '确认招聘'", "name: '确认添加'"))

await mutate('packages/world-runtime/src/projector.ts', (source) => source
  .replace('* 72,', '* 112,')
  .replace('+ row * 38,', '+ row * 112,'))

await mutate('packages/world-runtime/src/themes/cyber-company.ts', (source) => source
  .replace("participant: '员工'", "participant: '角色'")
  .replace("{ id: 'assign-task', label: '下达任务' }", "{ id: 'assign-task', label: '安排任务' }")
  .replace("{ id: 'inspect', label: '查看团队成长' }", "{ id: 'inspect', label: '查看角色成长' }"))

console.log('E2E wording, world placement and theme terminology aligned.')
