import { readFile, writeFile } from 'node:fs/promises'

async function replaceOnce(path, search, replacement, label) {
  const source = await readFile(path, 'utf8')
  const index = source.indexOf(search)
  if (index < 0) throw new Error(`Missing fix anchor: ${label}`)
  await writeFile(path, `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`)
}

await replaceOnce(
  'packages/web/src/App.tsx',
  `function metadataText(value: JsonObject[string]): string | undefined {`,
  `function metadataText(value: JsonObject[string] | undefined): string | undefined {`,
  'optional runtime metadata value',
)

await replaceOnce(
  'packages/web/src/components/ChatWorkbench.tsx',
  `  installedPlugins?: InstalledPluginCommand[]\n  pendingCount?: number`,
  `  installedPlugins?: InstalledPluginCommand[]\n  /** Compatibility for legacy callers; the primary App uses per-conversation counts. */\n  sending?: boolean\n  pendingCount?: number`,
  'legacy sending prop compatibility',
)

console.log('Applied chat realtime type compatibility fixes.')
