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
