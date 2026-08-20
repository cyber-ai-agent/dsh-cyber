import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))

describe('server architecture boundaries', () => {
  it('keeps server.ts as a small composition root without concrete API routes', async () => {
    const source = await readFile(join(sourceRoot, 'server.ts'), 'utf8')
    expect(source.split(/\r?\n/).length).toBeLessThanOrEqual(300)
    expect(source).not.toMatch(/["'`]\/api\//)
  })

  it('keeps route modules independent from one another', async () => {
    const routeRoot = join(sourceRoot, 'routes')
    for (const fileName of await readdir(routeRoot)) {
      if (extname(fileName) !== '.ts') continue
      const source = await readFile(join(routeRoot, fileName), 'utf8')
      expect(source, fileName).not.toMatch(/from\s+["'][^"']*(?:\/|\\)routes(?:\/|\\)/)
      expect(source, fileName).not.toMatch(/from\s+["']\.\/[^"']+-routes\.js["']/)
    }
  })

  it('has no relative import cycles in server source', async () => {
    const files = await listTypeScriptFiles(sourceRoot)
    const graph = new Map<string, string[]>()
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      const dependencies: string[] = []
      for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const specifier = match[1]!
        const dependency = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'))
        if (files.includes(dependency)) dependencies.push(dependency)
      }
      graph.set(file, dependencies)
    }

    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (file: string, path: string[]): void => {
      if (visiting.has(file)) {
        throw new Error(`Import cycle: ${[...path, file].map((item) => relative(sourceRoot, item)).join(' -> ')}`)
      }
      if (visited.has(file)) return
      visiting.add(file)
      for (const dependency of graph.get(file) ?? []) visit(dependency, [...path, file])
      visiting.delete(file)
      visited.add(file)
    }
    for (const file of files) visit(file, [])
  })
})

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(target))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(target)
  }
  return files
}
