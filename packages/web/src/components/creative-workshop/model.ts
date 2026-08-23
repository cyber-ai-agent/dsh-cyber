import type {
  EmbodimentPresetDescriptor,
  EmbodimentProfile,
  WorkshopCreateInput,
  WorkshopProject,
} from '@dsh-cyber/contracts/creative-platform'

export interface WorkshopRoleDraft {
  clientId: string
  displayName: string
  role: string
  summary: string
  persona: string
  embodimentPresetId?: string
  embodiment: EmbodimentProfile
  requestedSkillIds: string[]
}

export interface WorkshopDraft {
  displayName: string
  baseTemplateId: string
  lore: string
  scenario: string
  roles: WorkshopRoleDraft[]
}

export function createEmptyWorkshopDraft(
  baseTemplateId: string,
  preset: EmbodimentPresetDescriptor,
): WorkshopDraft {
  return {
    displayName: '',
    baseTemplateId,
    lore: '',
    scenario: '',
    roles: [createRoleDraft(1, preset)],
  }
}

export function createRoleDraft(index: number, preset: EmbodimentPresetDescriptor): WorkshopRoleDraft {
  return {
    clientId: `draft-${index}-${crypto.randomUUID()}`,
    displayName: '',
    role: '',
    summary: '',
    persona: '',
    embodimentPresetId: preset.id,
    embodiment: structuredClone(preset.profile),
    requestedSkillIds: [],
  }
}

export function projectToDraft(
  project: WorkshopProject,
  presets: readonly EmbodimentPresetDescriptor[],
): WorkshopDraft {
  return {
    displayName: `${project.displayName} 副本`,
    baseTemplateId: project.baseTemplateId,
    lore: project.lore,
    scenario: project.scenario,
    roles: project.roles.map((role, index) => ({
      clientId: `clone-${index}-${crypto.randomUUID()}`,
      displayName: role.displayName,
      role: role.role,
      summary: role.summary,
      persona: role.persona,
      ...(findPresetId(role.embodiment, presets) === undefined
        ? {}
        : { embodimentPresetId: findPresetId(role.embodiment, presets)! }),
      embodiment: structuredClone(role.embodiment),
      requestedSkillIds: [...role.requestedSkillIds],
    })),
  }
}

export function draftToCreateInput(draft: WorkshopDraft): WorkshopCreateInput {
  return {
    displayName: draft.displayName.trim(),
    baseTemplateId: draft.baseTemplateId,
    lore: draft.lore.trim(),
    scenario: draft.scenario.trim(),
    roles: draft.roles.map((role, index) => ({
      id: `role-${index + 1}`,
      displayName: role.displayName.trim(),
      role: role.role.trim(),
      summary: role.summary.trim(),
      persona: role.persona.trim(),
      embodiment: structuredClone(role.embodiment),
      requestedSkillIds: [...role.requestedSkillIds],
    })),
  }
}

export function validateWorkshopDraft(draft: WorkshopDraft): string | undefined {
  if (!draft.displayName.trim()) return '请填写世界名称'
  if (!draft.baseTemplateId.trim()) return '请选择基础运行时模板'
  if (draft.roles.length < 1) return '至少需要一个初始角色'
  const incomplete = draft.roles.find((role) =>
    !role.displayName.trim() || !role.role.trim() || !role.summary.trim() || !role.persona.trim(),
  )
  return incomplete === undefined
    ? undefined
    : `请补全角色“${incomplete.displayName || incomplete.role || '未命名角色'}”的资料`
}

function findPresetId(
  profile: WorkshopProject['roles'][number]['embodiment'],
  presets: readonly EmbodimentPresetDescriptor[],
): string | undefined {
  return presets.find((preset) => semanticProfileEquals(profile, preset.profile))?.id
}

function semanticProfileEquals(left: EmbodimentProfile, right: EmbodimentProfile): boolean {
  return stable(left) === stable(right)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}
