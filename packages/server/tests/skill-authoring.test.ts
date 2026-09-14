import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { normalizeSkillDraft, SkillAuthoringAnalyzer } from '../src/services/skill-authoring-analyzer.js'
import { compileSkillPackage } from '../src/services/skill-package-compiler.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('Skill authoring', () => {
  it('normalizes AI output into a declarative recipe and preserves an edited Skill id', () => {
    const current = normalizeSkillDraft({ id: 'custom.audit', displayName: '审计', summary: '核对资料。', instructions: '逐项核对。', routingHints: ['审计'] })
    const optimized = normalizeSkillDraft({ displayName: '证据审计', summary: '按证据核对资料。', instructions: '一、列出来源。\n二、核对结论。', routingHints: ['证据', '核验'], integrationId: 'evil.adapter', dataEgress: ['secret'] }, undefined, current)
    expect(optimized).toMatchObject({ id: 'custom.audit', displayName: '证据审计', integrationId: 'builtin.recipe', dataEgress: [] })
  })

  it('compiles skill.json, SKILL.md and an immutable package manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skill-compile-')); roots.push(root)
    const draft = normalizeSkillDraft({ id: 'custom.release-check', displayName: '发布检查', summary: '检查发布条件。', routingHints: ['发布', '检查'], instructions: '核对测试、版本和回滚方案。' })
    const { manifest } = await compileSkillPackage({ sourceDirectory: join(root, 'package'), packageId: 'generated.skill.release-check', packageVersion: '1.0.0', draft })
    expect(manifest).toMatchObject({ kind: 'skill', capabilities: ['skill:recipe'], dataEgress: [], entrypoints: [{ id: draft.id, kind: 'skill', path: 'skill.json' }] })
    expect(await readFile(join(root, 'package', 'SKILL.md'), 'utf8')).toContain('## 使用说明')
    expect(JSON.parse(await readFile(join(root, 'package', 'skill.json'), 'utf8'))).toMatchObject({ integrationId: 'builtin.recipe', instructions: draft.instructions })
  })

  it('uses the workspace model for AI optimization and keeps host-owned capability fields', async () => {
    const current = normalizeSkillDraft({ id: 'custom.audit', displayName: '审计', summary: '核对资料。', instructions: '逐项核对。', routingHints: ['审计'] })
    const analyzer = new SkillAuthoringAnalyzer(
      { getWorkspace: () => ({ id: 'workspace-skill' } as never), resolveWorkspaceDefaultProfile: () => ({ id: 'profile', workspaceId: 'workspace-skill', displayName: '模型', providerKind: 'openai-compatible-remote', baseUrl: 'https://models.example.test/v1', modelId: 'fake', api: 'openai-completions', isDefault: true, settings: {}, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z' }) },
      { resolve: () => 'key' } as never,
      { fetch: (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ id: 'replace-id', displayName: '证据审计', summary: '按来源核对。', routingHints: ['来源'], instructions: '列出来源，核对结论。', integrationId: 'external', dataEgress: ['secret'] }) } }] })) as typeof fetch, resolveHostname: { resolve: async () => ['93.184.216.34'] } },
    )
    const result = await analyzer.analyze({ workspaceId: 'workspace-skill', source: { kind: 'description', text: '优化审计步骤' }, current })
    expect(result.draft).toMatchObject({ id: current.id, displayName: '证据审计', integrationId: 'builtin.recipe', dataEgress: [] })
  })
})
