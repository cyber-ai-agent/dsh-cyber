import type { CyberPackageManifest, SkillAuthoringAnalyzeResult, SkillAuthoringDraft, SkillAuthoringPublishResult, SkillAuthoringSource, SkillDetailView, SkillSettingsScope, SkillSettingsView } from '@dsh-cyber/contracts'

import { api } from '../../api.js'
import { normalizeSkillCatalog, type SkillCatalogEntry } from '../../components/skill-catalog.js'

export async function listSkills(workspaceId: string): Promise<SkillCatalogEntry[]> {
  return normalizeSkillCatalog(await api<unknown>(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill-catalog`))
}

export function loadSkillSettings(workspaceId: string): Promise<SkillSettingsView> {
  return api(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill-settings`)
}

export function saveSkillSettings(workspaceId: string, input: { scope: SkillSettingsScope; scopeId: string; skillIds?: string[]; inherit?: boolean }): Promise<SkillSettingsView> {
  return api(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill-settings`, { method: 'PUT', body: JSON.stringify(input) })
}

export function loadSkillDetail(workspaceId: string, skillId: string): Promise<SkillDetailView> {
  return api(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/${encodeURIComponent(skillId)}/detail`)
}

export function analyzeSkill(workspaceId: string, source: SkillAuthoringSource, current?: SkillAuthoringDraft): Promise<SkillAuthoringAnalyzeResult> {
  return api(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill-authoring/analyze`, { method: 'POST', body: JSON.stringify({ source, ...(current === undefined ? {} : { current }) }) })
}

export function publishSkill(workspaceId: string, input: { source: SkillAuthoringSource; draft: SkillAuthoringDraft; basePackageId?: string; basePackageVersion?: string }): Promise<SkillAuthoringPublishResult> {
  return api(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill-authoring/publish`, { method: 'POST', body: JSON.stringify(input) })
}

export async function installSkillPackage(workspaceId: string, manifest: CyberPackageManifest, sourceDirectory: string, worldId?: string): Promise<void> {
  const preview = await api<{ approvalToken: string }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/packages/preview`, { method: 'POST', body: JSON.stringify({ manifest }) })
  await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/packages/install`, {
    method: 'POST',
    body: JSON.stringify({ manifest, sourceDirectory, approvalToken: preview.approvalToken }),
  })
  if (worldId === undefined) return
  const instances = await api<{ items: Array<{ id: string; packageId: string; packageVersion: string; status: string }> }>(`/api/worlds/${encodeURIComponent(worldId)}/packages`)
  const previous = instances.items.find((item) => item.status === 'active' && item.packageId === manifest.id && item.packageVersion !== manifest.version)
  try {
    if (previous !== undefined) await api(`/api/world-package-instances/${encodeURIComponent(previous.id)}/disable`, { method: 'POST', body: '{}' })
    await api(`/api/worlds/${encodeURIComponent(worldId)}/packages/instantiate`, { method: 'POST', body: JSON.stringify({ packageId: manifest.id, version: manifest.version }) })
  } catch (error) {
    if (previous !== undefined) await api(`/api/worlds/${encodeURIComponent(worldId)}/packages/instantiate`, { method: 'POST', body: JSON.stringify({ packageId: previous.packageId, version: previous.packageVersion }) }).catch(() => undefined)
    throw error
  }
}

export async function importSkillPackage(workspaceId: string, files: File[], worldId?: string): Promise<void> {
  if (files.length === 0) throw new Error('请选择 ZIP 或技能包文件夹。')
  const form = new FormData()
  const relativePaths = files.map((file) => {
    const candidate = file as File & { webkitRelativePath?: string }
    return candidate.webkitRelativePath || file.name
  })
  files.forEach((file) => form.append('files', file, file.name))
  form.append('relativePaths', JSON.stringify(relativePaths))
  if (worldId !== undefined) form.append('worldId', worldId)
  await requestForm(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill-authoring/import`, form)
}

async function requestForm(path: string, body: FormData): Promise<unknown> {
  const response = await fetch(path, { method: 'POST', body })
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined
    throw new Error(payload?.error?.message ?? `Request failed: ${response.status}`)
  }
  return response.json().catch(() => undefined)
}
