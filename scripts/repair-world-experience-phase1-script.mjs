import { readFile, writeFile } from 'node:fs/promises'

const path = 'scripts/apply-world-experience-phase1.mjs'
let source = await readFile(path, 'utf8')
source = source.replace(
  /placeholder=\{selectedExisting\.length > 0 \? `\$\{selected\.displayName\} \$\{selectedExisting\.length \+ 1\}` : selected\.displayName\}/g,
  "placeholder={selectedExisting.length > 0 ? selected.displayName + ' ' + (selectedExisting.length + 1) : selected.displayName}",
)
await writeFile(path, source, 'utf8')
