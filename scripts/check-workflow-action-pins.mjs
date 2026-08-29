import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const workflowDirectory = join(process.cwd(), '.github', 'workflows')
const files = (await readdir(workflowDirectory))
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort()

const violations = []
const fullCommitSha = /^[0-9a-f]{40}$/i
const usesLine = /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm

for (const file of files) {
  const source = await readFile(join(workflowDirectory, file), 'utf8')
  for (const match of source.matchAll(usesLine)) {
    const target = match[1]
    if (target.startsWith('./')) continue
    const separator = target.lastIndexOf('@')
    const reference = separator < 0 ? '' : target.slice(separator + 1)
    if (!fullCommitSha.test(reference)) {
      const line = source.slice(0, match.index).split('\n').length
      violations.push(`${file}:${line} ${target}`)
    }
  }
}

if (violations.length > 0) {
  console.error('Remote GitHub Actions must be pinned to a full 40-character commit SHA:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log(`Verified immutable action pins in ${files.length} workflow file(s).`)
