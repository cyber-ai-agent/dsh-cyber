import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CyberPackageManifest, JsonObject, SkillAuthoringDraft } from '@dsh-cyber/contracts'

import { parseSkillManifest } from '../skill-manifest.js'

export async function compileSkillPackage(input: { sourceDirectory: string; packageId: string; packageVersion: string; draft: SkillAuthoringDraft; source?: { originalText: string; originalFormat: 'md' | 'txt'; analysis: JsonObject } }): Promise<{ manifest: CyberPackageManifest }> {
  const { sourceSummary: _sourceSummary, ...manifestDraft } = input.draft
  const skill = parseSkillManifest(manifestDraft, { packageId: input.packageId, entrypointId: input.draft.id })
  const files: Array<{ path: string; bytes: Buffer }> = [
    { path: 'skill.json', bytes: jsonBytes(skill) },
    { path: 'SKILL.md', bytes: Buffer.from(skillMarkdown(skill), 'utf8') },
  ]
  if (input.source !== undefined) files.push(
    { path: `source/original.${input.source.originalFormat}`, bytes: Buffer.from(input.source.originalText, 'utf8') },
    { path: 'source/analysis.json', bytes: jsonBytes(input.source.analysis) },
  )
  let created = false
  try {
    await mkdir(dirname(input.sourceDirectory), { recursive: true, mode: 0o700 })
    await mkdir(input.sourceDirectory, { recursive: false, mode: 0o700 }); created = true
    for (const file of files) {
      const path = join(input.sourceDirectory, ...file.path.split('/'))
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 })
    }
    const manifest: CyberPackageManifest = {
      schemaVersion: 1, id: input.packageId, version: input.packageVersion, kind: 'skill',
      displayName: skill.displayName, summary: skill.summary, license: 'MIT', publisher: 'DSH Cyber Skill Center',
      capabilities: ['skill:recipe'], dataEgress: [], files: files.map((file) => ({ path: file.path, sha256: sha256(file.bytes) })),
      entrypoints: [{ id: skill.id, kind: 'skill', path: 'skill.json' }],
    }
    await writeFile(join(input.sourceDirectory, 'dsh-cyber.package.json'), jsonBytes(manifest), { flag: 'wx', mode: 0o600 })
    return { manifest }
  } catch (error) {
    if (created) await rm(input.sourceDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function skillMarkdown(skill: ReturnType<typeof parseSkillManifest>): string {
  return [
    `# ${skill.displayName}`,
    '',
    skill.summary,
    '',
    '## 使用说明',
    '',
    skill.instructions,
    '',
    '## 依赖',
    '',
    ...(skill.dependencies ?? []).map((item) => `- ${item.kind}: ${item.id}${item.required === false ? '（可选）' : ''}`),
    ...(skill.dependencies?.length === 0 || skill.dependencies === undefined ? ['- 无'] : []),
    '',
    '## 触发提示',
    '',
    ...(skill.routingHints ?? []).map((item) => `- ${item}`),
    '',
  ].join('\n')
}
function jsonBytes(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8') }
function sha256(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
