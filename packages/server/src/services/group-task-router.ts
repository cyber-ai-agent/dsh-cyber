import type {
  EmployeeInstance,
  EmployeeRevision,
  SkillCatalogEntry,
  TaskCollaborationExecutionMode,
  TaskCollaborationStepStatus,
} from '@dsh-cyber/contracts'

export interface GroupTaskRouterEmployee {
  employee: EmployeeInstance
  revision: EmployeeRevision
  /** Number of currently active AgentRuns for this employee. */
  activeLoad?: number
  /** Host capabilities resolved from the assigned model, such as image-generation. */
  capabilityIds?: readonly string[]
}

export interface RoutedTaskStep {
  id: string
  ordinal: number
  requiredSkills: string[]
  assignedEmployeeIds: string[]
  dependsOn: string[]
  executionMode: TaskCollaborationExecutionMode
  status: TaskCollaborationStepStatus
}

export interface GroupTaskRoutingInput {
  prompt: string
  employees: readonly GroupTaskRouterEmployee[]
  catalog: readonly SkillCatalogEntry[]
  coordinatorEmployeeId?: string
}

export interface GroupTaskRoutingResult {
  requiredSkillIds: string[]
  steps: RoutedTaskStep[]
  coordinatorEmployeeId: string
}

export type DirectSkillDelegationDecision =
  | { kind: 'none'; requiredSkillIds: [] }
  | {
      kind: 'delegate'
      requiredSkillIds: string[]
      targetEmployeeId: string
      candidateEmployeeIds: string[]
    }
  | {
      kind: 'choice'
      requiredSkillIds: string[]
      candidateEmployeeIds: string[]
      candidateDisplayNames: string[]
    }
  | {
      kind: 'unavailable'
      requiredSkillIds: string[]
      candidateEmployeeIds: []
      guidance: string
    }

/**
 * Resolves a direct request whose selected character does not hold a matched
 * Skill. The resolver only uses world-visible catalog hints and current
 * revision grants, so it can recommend a real character without handing an
 * adapter or provider detail to the model.
 */
export function resolveDirectSkillDelegation(input: {
  prompt: string
  initiator: GroupTaskRouterEmployee
  employees: readonly GroupTaskRouterEmployee[]
  catalog: readonly SkillCatalogEntry[]
}): DirectSkillDelegationDecision {
  const prompt = normalize(input.prompt)
  // A casual question can contain a catalog word such as “会话” or “搜索”
  // without asking the host to perform a capability-backed action. Keep this
  // preflight behind an explicit action cue so ordinary direct chat is never
  // blocked by a missing optional Skill grant.
  if (!/(?:生成|制作|执行|调用|使用|生图|生视频|搜索|浏览|访问|导出|上传|下载|运行|创建|修改|写入|配置|研究|分析|整理|查找|查询|处理|编程|开发)/iu.test(prompt)) {
    return { kind: 'none', requiredSkillIds: [] }
  }
  const matched = input.catalog
    // Direct fallback is for concrete host capabilities (image/video,
    // browser, external search, and similar integrations). Built-in writing
    // recipes are conversational guidance and should not block an ordinary
    // task-intent turn merely because a role has not opted into that recipe.
    .filter((skill) => skill.worldAvailable && skill.kind === 'integration')
    .map((skill) => ({ skill, match: matchLocation(prompt, skill) }))
    .filter((item): item is { skill: SkillCatalogEntry; match: SkillMatch } => item.match !== undefined)
    .sort((left, right) => left.match.index - right.match.index || right.match.specificity - left.match.specificity || left.skill.id.localeCompare(right.skill.id))
  const requiredSkillIds = [...new Set(matched.map((item) => item.skill.id))]
  const mediaCapability = directMediaCapability(prompt)
  const modelCapability = mediaCapability !== undefined && !matched.some(({ skill }) =>
    (skill.routingHints ?? []).some((hint) => /(?:图|图片|图像|视频|image|video)/iu.test(hint)),
  ) ? mediaCapability : undefined
  if (modelCapability !== undefined && !requiredSkillIds.includes(modelCapability.id)) requiredSkillIds.push(modelCapability.id)
  const missingSkillIds = requiredSkillIds.filter((skillId) => skillId === modelCapability?.id
    ? !input.initiator.capabilityIds?.includes(skillId)
    : !input.initiator.revision.skillGrants.includes(skillId))
  if (missingSkillIds.length === 0) return { kind: 'none', requiredSkillIds: [] }

  // A single direct request should have one capable executor for all matched
  // capabilities. If several roles qualify, asking the owner is safer than
  // silently choosing by load or display order.
  const candidates = input.employees
    .filter((item) => item.employee.id !== input.initiator.employee.id && item.employee.status !== 'archived')
    .filter((item) => missingSkillIds.every((skillId) => skillId === modelCapability?.id
      ? item.capabilityIds?.includes(skillId) === true
      : item.revision.skillGrants.includes(skillId)))
    .sort((left, right) => left.employee.id.localeCompare(right.employee.id))
  if (candidates.length === 1) {
    return {
      kind: 'delegate',
      requiredSkillIds: missingSkillIds,
      targetEmployeeId: candidates[0]!.employee.id,
      candidateEmployeeIds: [candidates[0]!.employee.id],
    }
  }
  if (candidates.length > 1) {
    return {
      kind: 'choice',
      requiredSkillIds: missingSkillIds,
      candidateEmployeeIds: candidates.map((item) => item.employee.id),
      candidateDisplayNames: candidates.map((item) => item.employee.displayName),
    }
  }

  const labels = matched
    .filter((item) => missingSkillIds.includes(item.skill.id))
    .map((item) => item.skill.displayName)
  if (modelCapability !== undefined && missingSkillIds.includes(modelCapability.id)) labels.push(modelCapability.label)
  return {
    kind: 'unavailable',
    requiredSkillIds: missingSkillIds,
    candidateEmployeeIds: [],
    guidance: `当前角色没有${labels.length > 0 ? `“${labels.join('、')}”` : '所需'}能力。请在“档案 → 角色 → Skill 授权”中给一个角色授权；如果世界尚未启用该能力，请先在市场安装对应插件，也可以改派给已有能力的角色。`,
  }
}

function directMediaCapability(prompt: string): { id: string; label: string } | undefined {
  if (/(?:生视频|生成视频|视频生成|video generation|generate video)/iu.test(prompt)) {
    return { id: 'video-generation', label: '视频生成' }
  }
  if (/(?:生图|生成图片|生成图像|图片生成|image generation|generate image)/iu.test(prompt)) {
    return { id: 'image-generation', label: '图片生成' }
  }
  return undefined
}

/**
 * Deterministic task routing for a group session.
 *
 * The router only sees the provider-neutral catalog and current employee
 * revision. It never imports an adapter or asks a model to classify the
 * request. Skill descriptors provide the bounded `routingHints` vocabulary.
 */
export class GroupTaskRouter {
  route(input: GroupTaskRoutingInput): GroupTaskRoutingResult {
    const prompt = normalize(input.prompt)
    const available = input.catalog.filter((skill) => skill.worldAvailable)
    const matched = available
      .map((skill) => ({ skill, match: matchLocation(prompt, skill) }))
      .filter((item): item is { skill: SkillCatalogEntry; match: SkillMatch } => item.match !== undefined)
      // When two declarations match at the same position, the longer declared
      // hint is the more specific route ("搜索官网" before generic "搜索").
      .sort((left, right) => left.match.index - right.match.index || right.match.specificity - left.match.specificity || left.skill.id.localeCompare(right.skill.id))

    const selected = new Set<string>()
    const steps: RoutedTaskStep[] = []
    for (const item of matched) {
      if (steps.length >= 3) break
      const candidate = bestCandidate(item.skill, prompt, input.employees, selected)
      if (candidate === undefined) continue
      const existing = steps.find((step) => step.assignedEmployeeIds.includes(candidate.employee.id))
      if (existing !== undefined) {
        // One employee may be the only capable executor for multiple skills;
        // merge those skills into one step instead of creating parallel runs
        // that mutate the same character runtime concurrently.
        if (!existing.requiredSkills.includes(item.skill.id)) existing.requiredSkills.push(item.skill.id)
        continue
      }
      selected.add(candidate.employee.id)
      const ordinal = steps.length + 1
      steps.push({
        id: `route-step-${ordinal}-${safeId(item.skill.id)}`,
        ordinal,
        requiredSkills: [item.skill.id],
        assignedEmployeeIds: [candidate.employee.id],
        dependsOn: [],
        executionMode: 'parallel',
        status: 'pending',
      })
    }

    if (hasSequentialConnector(prompt) && steps.length > 1) {
      for (let index = 1; index < steps.length; index += 1) {
        const previous = steps[index - 1]!
        const current = steps[index]!
        current.dependsOn = [previous.id]
        current.executionMode = 'sequential'
      }
    }

    // A task without a recognized skill still needs one deterministic owner;
    // an explicit @ mention wins, followed by the least-loaded participant.
    if (steps.length === 0) {
      const candidate = bestCandidate(undefined, prompt, input.employees, new Set())
      if (candidate !== undefined) {
        steps.push({
          id: 'route-step-1-general',
          ordinal: 1,
          requiredSkills: [],
          assignedEmployeeIds: [candidate.employee.id],
          dependsOn: [],
          executionMode: 'parallel',
          status: 'pending',
        })
      }
    }

    const coordinator = resolveCoordinator(input, prompt, steps)
    return {
      requiredSkillIds: [...new Set(steps.flatMap((step) => step.requiredSkills))],
      steps,
      coordinatorEmployeeId: coordinator,
    }
  }
}

function bestCandidate(
  skill: SkillCatalogEntry | undefined,
  prompt: string,
  employees: readonly GroupTaskRouterEmployee[],
  alreadySelected: ReadonlySet<string>,
): GroupTaskRouterEmployee | undefined {
  const eligible = employees
    .filter((item) => item.employee.status !== 'archived')
    .filter((item) => skill === undefined || item.revision.skillGrants.includes(skill.id))
  const fresh = eligible.some((item) => !alreadySelected.has(item.employee.id))
    ? eligible.filter((item) => !alreadySelected.has(item.employee.id))
    : eligible
  const scored = fresh
    .map((item) => ({
      item,
      score: scoreCandidate(skill, prompt, item, alreadySelected.has(item.employee.id)),
    }))
    .sort((left, right) => right.score - left.score || left.item.employee.id.localeCompare(right.item.employee.id))
  return scored[0]?.item
}

function scoreCandidate(
  skill: SkillCatalogEntry | undefined,
  prompt: string,
  candidate: GroupTaskRouterEmployee,
  alreadySelected: boolean,
): number {
  const explicitMention = prompt.includes(`@${normalize(candidate.employee.displayName)}`) ? 120 : 0
  const roleMatch = prompt.includes(normalize(candidate.employee.role)) ? 35 : 0
  const skillMatch = skill !== undefined && candidate.revision.skillGrants.includes(skill.id) ? 100 : 0
  const loadPenalty = Math.min(80, Math.max(0, candidate.activeLoad ?? 0) * 20)
  const duplicatePenalty = alreadySelected ? 40 : 0
  return skillMatch + roleMatch + explicitMention - loadPenalty - duplicatePenalty
}

function resolveCoordinator(
  input: GroupTaskRoutingInput,
  prompt: string,
  steps: readonly RoutedTaskStep[],
): string {
  if (input.coordinatorEmployeeId !== undefined && input.employees.some((item) => item.employee.id === input.coordinatorEmployeeId)) {
    return input.coordinatorEmployeeId
  }
  const mentioned = input.employees.find((item) => prompt.includes(`@${normalize(item.employee.displayName)}`))
  if (mentioned !== undefined) return mentioned.employee.id
  const assigned = new Set(steps.flatMap((step) => step.assignedEmployeeIds))
  const candidate = input.employees
    .filter((item) => assigned.has(item.employee.id) && item.employee.status !== 'archived')
    .sort((left, right) => (left.activeLoad ?? 0) - (right.activeLoad ?? 0) || left.employee.id.localeCompare(right.employee.id))[0]
  return candidate?.employee.id ?? input.employees.find((item) => item.employee.status !== 'archived')?.employee.id ?? ''
}

interface SkillMatch {
  index: number
  specificity: number
}

function matchLocation(prompt: string, skill: SkillCatalogEntry): SkillMatch | undefined {
  const descriptor = skill as SkillCatalogEntry & { routingHints?: string[] }
  // Routing is deliberately driven only by the host-declared vocabulary. A
  // provider id, adapter name, or arbitrary summary text must not silently
  // become a task-selection rule.
  const hints = (descriptor.routingHints ?? [])
    .map(normalize)
    .filter((value) => value.length >= 2)
  const matches = hints
    .map((hint) => ({ hint, index: prompt.indexOf(hint) }))
    .filter((value) => value.index >= 0)
  if (matches.length === 0) return undefined
  const index = Math.min(...matches.map((value) => value.index))
  return {
    index,
    specificity: Math.max(...matches.filter((value) => value.index === index).map((value) => value.hint.length)),
  }
}

function hasSequentialConnector(prompt: string): boolean {
  return /(?:然后|再(?:由|去|做)?|随后|之后|完成后|接着|then|after|once|follow(?:ing)?)/iu.test(prompt)
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ')
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'skill'
}
