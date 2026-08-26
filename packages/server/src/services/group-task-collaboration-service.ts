import type {
  AgentPermissionMode,
  JsonObject,
  ReasoningEffort,
  TaskCollaborationPlan,
  WorkSession,
  WorkSessionCollaborationMode,
} from '@dsh-cyber/contracts'
import type {
  ConversationOrchestrator,
  TaskConversationResult,
} from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { GroupTaskRouter, type GroupTaskRouterEmployee } from './group-task-router.js'
import type { SkillCatalogService } from './skill-catalog-service.js'
import type { WorldRuntimePromptComposer } from './world-runtime-context-composer.js'

interface SessionModeStore {
  updateSessionCollaborationMode?(input: { sessionId: string; collaborationMode: WorkSessionCollaborationMode; actorId?: string }): WorkSession
  /** Direct world-scoped lookups keep plan reads off the full world list path. */
  getTaskCollaborationPlanByTurn(worldId: string, workTurnId: string): TaskCollaborationPlan | undefined
  getLatestTaskCollaborationPlanForSession(worldId: string, sessionId: string): TaskCollaborationPlan | undefined
}

export interface GroupTaskCollaborationServiceOptions {
  store: SqliteStore & SessionModeStore
  catalog: SkillCatalogService
  orchestrator: ConversationOrchestrator
  runtimeContext: Pick<WorldRuntimePromptComposer, 'composeGroupRuntimePrompt'>
}

export interface GroupTaskRunInput {
  workspaceId: string
  worldId: string
  employeeIds: string[]
  prompt: string
  transformedPrompt: string
  metadata?: JsonObject
  reasoningEffort?: Exclude<ReasoningEffort, 'auto'>
  permissionMode?: AgentPermissionMode
  sessionId?: string
  title?: string
  coordinatorEmployeeId?: string
  existingWorkTurnId?: string
}

export interface GroupTaskAssignmentView {
  stepId: string
  employeeIds: string[]
  requiredSkills: string[]
  status: TaskCollaborationPlan['steps'][number]['status']
}

export interface GroupTaskRunResult extends TaskConversationResult {
  requiredSkillIds: string[]
  assignments: GroupTaskAssignmentView[]
}

export interface GroupTaskPlanView {
  plan: TaskCollaborationPlan
  skillLabels: Record<string, string>
}

/**
 * Server-side composition of catalog routing and one WorkTurn task execution.
 *
 * The Router only selects employees and declared skills. This service creates
 * real AgentRuns through the provider-neutral orchestrator; it does not call a
 * Skill Adapter or claim an external action happened. The conversation-control
 * lifecycle prepares at most one matching host Skill action before this
 * service runs and passes only its durable factual result in transformedPrompt.
 */
export class GroupTaskCollaborationService {
  readonly #store: GroupTaskCollaborationServiceOptions['store']
  readonly #catalog: SkillCatalogService
  readonly #orchestrator: ConversationOrchestrator
  readonly #runtimeContext: GroupTaskCollaborationServiceOptions['runtimeContext']
  readonly #router = new GroupTaskRouter()

  constructor(options: GroupTaskCollaborationServiceOptions) {
    this.#store = options.store
    this.#catalog = options.catalog
    this.#orchestrator = options.orchestrator
    this.#runtimeContext = options.runtimeContext
  }

  async run(input: GroupTaskRunInput): Promise<GroupTaskRunResult> {
    const world = this.#store.getWorld(input.worldId)
    if (world === undefined || world.workspaceId !== input.workspaceId || world.status === 'archived') {
      throw new Error('World is unavailable')
    }
    const employeeIds = [...new Set(input.employeeIds.map((id) => id.trim()).filter(Boolean))]
    const activeLoadByEmployee = new Map<string, number>()
    for (const run of this.#store.listWorldAgentRuns(input.worldId)) {
      if (run.status !== 'queued' && run.status !== 'running') continue
      activeLoadByEmployee.set(run.employeeId, (activeLoadByEmployee.get(run.employeeId) ?? 0) + 1)
    }
    const employees: GroupTaskRouterEmployee[] = employeeIds.map((employeeId) => {
      const employee = this.#store.getEmployee(employeeId)
      if (employee === undefined || employee.workspaceId !== input.workspaceId || employee.worldId !== input.worldId || employee.status === 'archived') {
        throw new Error(`Task participant is unavailable: ${employeeId}`)
      }
      const revision = this.#store.getEmployeeRevision(employee.id, employee.currentRevision)
      if (revision === undefined) throw new Error(`Task participant revision is unavailable: ${employeeId}`)
      return { employee, revision, activeLoad: activeLoadByEmployee.get(employee.id) ?? 0 }
    })
    const catalog = await this.#catalog.listWorld(input.worldId)
    const routing = this.#router.route({
      prompt: input.prompt,
      employees,
      catalog,
      ...(input.coordinatorEmployeeId === undefined ? {} : { coordinatorEmployeeId: input.coordinatorEmployeeId }),
    })
    if (routing.steps.length === 0 || routing.coordinatorEmployeeId === '') {
      throw new Error('Task Router could not select an executor')
    }
    const runtimePrompt = await this.#runtimeContext.composeGroupRuntimePrompt(input.worldId, input.transformedPrompt)
    const result = await this.#orchestrator.task({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      employeeIds,
      coordinatorEmployeeId: routing.coordinatorEmployeeId,
      prompt: input.prompt,
      runtimePrompt,
      steps: routing.steps,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.existingWorkTurnId === undefined ? {} : { existingWorkTurnId: input.existingWorkTurnId }),
    })
    return {
      ...result,
      requiredSkillIds: [...routing.requiredSkillIds],
      assignments: result.plan.steps.map((step) => ({
        stepId: step.id,
        employeeIds: [...step.assignedEmployeeIds],
        requiredSkills: [...step.requiredSkills],
        status: step.status,
      })),
    }
  }

  getPlan(worldId: string, planId: string): TaskCollaborationPlan | undefined {
    const plan = this.#store.getTaskCollaborationPlan(planId)
    return plan?.worldId === worldId ? plan : undefined
  }

  getPlanForTurn(worldId: string, turnId: string): TaskCollaborationPlan | undefined {
    return this.#store.getTaskCollaborationPlanByTurn(worldId, turnId)
  }

  getPlanForSession(worldId: string, sessionId: string): TaskCollaborationPlan | undefined {
    return this.#store.getLatestTaskCollaborationPlanForSession(worldId, sessionId)
  }

  async presentPlan(plan: TaskCollaborationPlan): Promise<GroupTaskPlanView> {
    const required = new Set(plan.steps.flatMap((step) => step.requiredSkills))
    const skillLabels: Record<string, string> = {}
    for (const item of await this.#catalog.listWorld(plan.worldId)) {
      if (required.has(item.id)) skillLabels[item.id] = item.displayName
    }
    return { plan, skillLabels }
  }

  setMode(sessionId: string, mode: WorkSessionCollaborationMode): WorkSession {
    if (this.#store.updateSessionCollaborationMode === undefined) {
      throw new Error('Session collaboration mode persistence is unavailable')
    }
    return this.#store.updateSessionCollaborationMode({ sessionId, collaborationMode: mode, actorId: 'owner' })
  }
}
