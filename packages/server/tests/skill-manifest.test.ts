import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CyberPackageManifest } from '@dsh-cyber/contracts'
import type { StagedPackage } from '@dsh-cyber/package-runtime'
import { validateStagedPackageEntrypoints } from '../src/installed-package-runtime.js'
import { parseSkillManifest } from '../src/skill-manifest.js'

const valid = {
  schemaVersion: 1,
  id: 'web.search.firecrawl',
  displayName: '联网搜索',
  summary: '通过受信任的网页搜索连接查找公开资料。',
  routingHints: ['联网搜索', 'web search'],
  integrationId: 'builtin.firecrawl',
  dataEgress: ['搜索查询文本'],
  instructions: '只在用户明确要求联网搜索时使用，并保留可点击来源。',
}

describe('skill manifest', () => {
  it('parses declaration-only skill metadata', () => {
    expect(parseSkillManifest(valid, {
      packageId: 'official-firecrawl-search',
      entrypointId: valid.id,
    })).toEqual(valid)
  })

  it.each([
    ['unknown field', { ...valid, executable: 'node script.js' }],
    ['wrong schema', { ...valid, schemaVersion: 2 }],
    ['entrypoint identity mismatch', { ...valid, id: 'another.skill' }],
    ['duplicate egress declaration', { ...valid, dataEgress: ['same', 'same'] }],
    ['empty instructions', { ...valid, instructions: ' ' }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseSkillManifest(value, {
      packageId: 'official-firecrawl-search',
      entrypointId: valid.id,
    })).toThrow()
  })

  it('validates a staged skill entrypoint before package activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-manifest-stage-'))
    try {
      const body = `${JSON.stringify(valid)}\n`
      await writeFile(join(root, 'skill.json'), body, 'utf8')
      const manifest: CyberPackageManifest = {
        schemaVersion: 1, id: 'official-firecrawl-search', version: '1.0.0', kind: 'skill',
        displayName: '联网搜索 Skill', summary: '声明联网搜索能力。', license: 'MIT', publisher: 'DSH Cyber',
        capabilities: ['integration:firecrawl'], dataEgress: ['https://api.firecrawl.dev'],
        files: [{ path: 'skill.json', sha256: createHash('sha256').update(body).digest('hex') }],
        entrypoints: [{ id: valid.id, kind: 'skill', path: 'skill.json' }],
      }
      const staged: StagedPackage = { manifest, path: root }
      await expect(validateStagedPackageEntrypoints(staged)).resolves.toBeUndefined()
      await expect(validateStagedPackageEntrypoints({
        path: root,
        manifest: { ...manifest, entrypoints: [] },
      })).rejects.toThrow('at least one skill entrypoint')
      await expect(validateStagedPackageEntrypoints({
        path: root,
        manifest: {
          ...manifest,
          entrypoints: [
            ...manifest.entrypoints!,
            { id: 'prompt', kind: 'prompt-transform', path: 'skill.json' },
          ],
        },
      })).rejects.toThrow('cannot mix entrypoint kinds')

      await writeFile(join(root, 'skill.json'), JSON.stringify({ ...valid, instructions: '' }), 'utf8')
      await expect(validateStagedPackageEntrypoints(staged)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
