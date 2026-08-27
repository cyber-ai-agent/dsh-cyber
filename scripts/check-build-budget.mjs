import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

const assets = join(process.cwd(), 'packages', 'web', 'dist', 'assets')
const files = await readdir(assets)
const sizes = new Map(await Promise.all(files.map(async (file) => [file, (await stat(join(assets, file))).size])))

const budgets = [
  { label: 'main JavaScript', pattern: /^index-.*\.js$/, maximum: 450 * 1024 },
  { label: 'main CSS', pattern: /^index-.*\.css$/, maximum: 280 * 1024 },
  { label: 'Task Workspace JavaScript', pattern: /^TaskWorkspace-.*\.js$/, maximum: 25 * 1024 },
  { label: 'Task Workspace CSS', pattern: /^TaskWorkspace-.*\.css$/, maximum: 10 * 1024 },
]

const errors = []
for (const budget of budgets) {
  const match = [...sizes].find(([file]) => budget.pattern.test(file))
  if (match === undefined) errors.push(`${budget.label}: output missing`)
  else if (match[1] > budget.maximum) errors.push(`${budget.label}: ${match[1]} > ${budget.maximum} bytes`)
}
if (files.some((file) => file.endsWith('.map'))) errors.push('release build contains public source maps')
if (errors.length > 0) throw new Error(`Build budget failed:\n${errors.join('\n')}`)
console.log('Build budget passed:', budgets.map((item) => item.label).join(', '))
