import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { SUPPORTED_UI_LOCALES } from '@dsh-cyber/contracts'

const sourceRoot = join(process.cwd(), 'packages', 'web', 'src')

describe('localization regression guard', () => {
  it('keeps the synchronous first-paint locale list aligned with the contract', () => {
    const bootstrap = readFileSync(join(process.cwd(), 'packages', 'web', 'public', 'locale-bootstrap.js'), 'utf8')
    const match = bootstrap.match(/const supported = \[([^\]]+)\]/)
    expect(match).not.toBeNull()
    const locales = Array.from(match?.[1].matchAll(/'([^']+)'/g) ?? [], (item) => item[1])
    expect(locales).toEqual([...SUPPORTED_UI_LOCALES])
  })

  it('does not hard-code a locale in date and number formatting', () => {
    const files = [
      'App.tsx',
      'chat-realtime.ts',
      'components/ChatWorkbench.tsx',
      'components/NavigationPane.tsx',
      'components/SettingsDialog.tsx',
      'components/TaskSchedulePanel.tsx',
      'components/world-trace/WorldTraceItem.tsx',
      'features/artifacts/ArtifactCenter.tsx',
      'features/artifacts/ArtifactDetail.tsx',
      'features/knowledge/KnowledgeLibrary.tsx',
      'features/tasks/TaskWorkspace.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(join(sourceRoot, file), 'utf8')
      expect(source, file).not.toMatch(/toLocale(?:Date|Time)?String\(\s*['"][a-z]{2}-[A-Z]{2}['"]/) 
    }
  })

  it('does not render task protocol enums as user-facing copy', () => {
    const source = readFileSync(join(sourceRoot, 'features', 'tasks', 'TaskWorkspace.tsx'), 'utf8')
    expect(source).not.toMatch(/>\s*\{(?:plan|step|run|deliverable)\.status\}\s*</)
    expect(source).not.toMatch(/>\s*\{review\.decision\}\s*</)
    expect(source).not.toMatch(/`[^`]*\b(?:AgentRun|WorkTurn|Artifact)\b[^`]*`/)
  })
})
