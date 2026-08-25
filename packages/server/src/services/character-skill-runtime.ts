import { randomUUID } from 'node:crypto'

import type { ApprovalPolicy, ApprovalRequest, ApprovalScope } from '@dsh-cyber/contracts'
import type {
  CharacterSkillAction,
  CharacterSkillDescriptor,
  CharacterSkillResult,
} from '@dsh-cyber/contracts/skill-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import type { CharacterSkillActionRepository } from '../skills/skill-action-repository.js'
import type { CharacterSkillAdapterRegistry } from '../skills/skill-adapter.js'
import { ServiceError } from './service-error.js'

const TICK_MS = 30_000
const DUPLICATE_WINDOW_MS = 60_000
const APPROVAL_TTL_MS = 10 * 60_000

export interface CharacterSkillRuntimeOptions {
  registry: CharacterSkillAdapterRegistry
  actions: CharacterSkillActionRepository
}

export interface SkillPreparationContext {
  workspaceId: string
  worldId: string
  sessionId: string
  workTurnId: string
  characterId: string
  prompt: string
  agentRunId?: string
}

/**
 * Provider- and persistence-neutral Skill orchestration.
 *
 * Responsibilities stay deliberately narrow: authorize by current character
 * revision, ask a host-injected registry for structured proposals, reserve
 * durable actions, schedule them, and feed factual execution results back to
 * the Agent. Provider registration and storage implementation both live outside
 * this class.
 */
export class CharacterSkillRuntime {
  readonly #store: SqliteStore
  readonly #registry: CharacterSkillAdapterRegistry
  readonly #actions: CharacterSkillActionRepository
  #timer: NodeJS.Timeout | undefined
  #ticking = false
  #approvalSettlementHandler: ((workTurnId: string) => Promise<void>) | undefined

  constructor(store: SqliteStore, options: CharacterSkillRuntimeOptions) {
    this.#store = store
    this.#registry = options.registry
    this.#actions = options.actions
  }

  start(): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS)
    this.#timer.unref()
  }

  close(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  setApprovalSettlementHandler(handler: (workTurnId: string) => Promise<void>): void {
    this.#approvalSettlementHandler = handler
  }

  listDescriptors(): CharacterSkillDescriptor[] {
    return this.#registry.list()
  }

  async prepare(context: SkillPreparationContext, now = new Date()): Promise<CharacterSkillResult> {
    const { workspaceId, worldId, sessionId, workTurnId, characterId, prompt, agentRunId } = context
    const employee = this.#store.getEmployee(characterId)
    const turn = this.#store.getWorkTurn(workTurnId)
    if (employee === undefined || employee.workspaceId !== workspaceId || employee.worldId !== worldId || employee.status === 'archived'
      || turn === undefined || turn.workspaceId !== workspaceId || turn.worldId !== worldId || turn.sessionId !== sessionId) {
      return { handled: false, actions: [] }
    }
    const revision = this.#store.getEmployeeRevision(employee.id, employee.currentRevision)
    if (revision === undefined || revision.skillGrants.length === 0) return { handled: false, actions: [] }

    const proposals = await this.#registry.propose({
      worldId,
      characterId,
      prompt,
      grantedSkillIds: revision.skillGrants,
      now,
    })
    if (proposals.length === 0) return { handled: false, actions: [] }

    const actions: CharacterSkillAction[] = []
    for (const proposal of proposals) {
      if (!revision.skillGrants.includes(proposal.skillId)) continue

      const candidate: CharacterSkillAction = {
        id: randomUUID(),
        worldId,
        characterId,
        skillId: proposal.skillId,
        adapterId: proposal.adapterId,
        action: proposal.action,
        target: proposal.target,
        label: proposal.label,
        risk: proposal.risk,
        authorization: proposal.authorization,
        parameters: proposal.parameters ?? {},
        ...(proposal.scheduledFor === undefined ? {} : { scheduledFor: proposal.scheduledFor }),
        workTurnId,
        ...(agentRunId === undefined ? {} : { agentRunId }),
        status: proposal.risk === 'external-side-effect'
          ? 'waiting-for-approval'
          : proposal.scheduledFor === undefined ? 'waiting-for-integration' : 'scheduled',
        detail: proposal.risk === 'external-side-effect'
          ? '外部动作已安全预留，等待用户审批'
          : proposal.scheduledFor === undefined
          ? '已预留真实动作，正在通过受信任技能适配器执行'
          : `已创建本地计划，将在 ${localTimeLabel(proposal.scheduledFor)} 尝试执行`,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }

      // reserve() is the atomic de-duplication boundary. An immediate external
      // side effect is never executed before its durable reservation exists.
      const reservation = await this.#actions.reserve(candidate, DUPLICATE_WINDOW_MS)
      const action = reservation.action
      if (!reservation.created) {
        await this.#discard(candidate)
        actions.push(action)
        continue
      }

      if (!this.#authorize(action, now)) {
        await this.#actions.save(action)
        actions.push(action)
        continue
      }

      // Authorization can change status and provenance (for example when an
      // exact-target policy matches). Persist that fact before the execution
      // state machine reloads the action from SQLite.
      await this.#actions.save(action)

      if (action.scheduledFor === undefined) {
        if (await this.#execute(action, now)) await this.#actions.save(action)
      } else {
        Object.assign(action, this.#store.prepareSkillActionExecution(action.id, now.toISOString()))
      }
      actions.push(action)
    }

    if (actions.length === 0) return { handled: false, actions: [] }
    const skillIds = [...new Set(actions.map((item) => item.skillId))]
    return {
      handled: true,
      ...(skillIds.length === 1 ? { skillId: skillIds[0] } : {}),
      summary: skillSummary(actions),
      actions,
    }
  }

  list(worldId: string): Promise<CharacterSkillAction[]> {
    return this.#actions.listByWorld(worldId)
  }

  listApprovalRequests(worldId: string, status?: ApprovalRequest['status']): ApprovalRequest[] {
    return this.#store.listWorldApprovalRequests(worldId, status)
  }

  listApprovalPolicies(worldId: string): ApprovalPolicy[] {
    return this.#store.listWorldApprovalPolicies(worldId)
  }

  getApprovalPolicy(policyId: string): ApprovalPolicy | undefined {
    return this.#store.getApprovalPolicy(policyId)
  }

  revokeApprovalPolicy(policyId: string): ApprovalPolicy {
    return this.#store.revokeApprovalPolicy(policyId)
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    scope: ApprovalScope,
    actorId: string,
    now = new Date(),
  ): Promise<{ request: ApprovalRequest; action: CharacterSkillAction }> {
    const pending = this.#store.getApprovalRequest(approvalId)
    if (pending === undefined) throw new Error(`Approval request not found: ${approvalId}`)
    if (pending.subjectType !== 'skill-action' || this.#actions.get === undefined) {
      throw new Error('Approval request is not backed by a skill action')
    }
    const action = await this.#actions.get(pending.subjectId)
    if (action === undefined || action.worldId !== pending.worldId || action.approvalRequestId !== pending.id) {
      throw new Error('Approval request and skill action do not match')
    }
    if (this.#store.getApprovalRequest(approvalId)?.status !== 'pending') {
      throw new ServiceError('conflict', 'approval_already_decided', '审批请求已经处理')
    }
    const descriptor = this.#registry.descriptorForSkill(action.skillId)
    if (decision === 'approved' && scope !== 'once' && descriptor?.persistentApproval !== 'exact-target') {
      throw new ServiceError('invalid', 'persistent_approval_forbidden', '该动态工具只允许单次审批')
    }
    const request = this.#store.decideApprovalRequest(approvalId, decision, scope, actorId, now.toISOString())
    if (request.status !== 'approved') {
      action.status = 'rejected'
      action.detail = request.status === 'expired'
        ? '该操作未执行，因为审批已过期。'
        : '该操作未执行，因为审批被拒绝。'
      action.executionState = 'settled'
      action.executionCompletedAt = now.toISOString()
      action.updatedAt = now.toISOString()
      await this.#discard(action)
      await this.#actions.save(action)
      return { request, action }
    }
    if (request.scope !== 'once') {
      this.#store.createApprovalPolicy({
        workspaceId: request.workspaceId,
        worldId: request.worldId,
        ...(request.scope === 'character' ? { characterId: action.characterId } : {}),
        subjectType: 'skill-action',
        skillId: action.skillId,
        action: action.action,
        target: action.target,
        risk: action.risk,
        scope: request.scope,
        sourceApprovalId: request.id,
      })
    }
    if (action.scheduledFor !== undefined && Date.parse(action.scheduledFor) > now.getTime()) {
      action.status = 'scheduled'
      action.detail = `已获批准，将在 ${localTimeLabel(action.scheduledFor)} 尝试执行`
      await this.#actions.save(action)
      Object.assign(action, this.#store.prepareSkillActionExecution(action.id, now.toISOString()))
    } else {
      action.status = 'waiting-for-integration'
      action.detail = '审批已通过，等待安全进入受信任技能适配器'
      await this.#actions.save(action)
      Object.assign(action, this.#store.prepareSkillActionExecution(action.id, now.toISOString()))
      if (!await this.#execute(action, now)) return { request, action }
    }
    action.updatedAt = now.toISOString()
    await this.#actions.save(action)
    return { request, action }
  }

  async tick(now = new Date()): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    try {
      this.#store.expirePendingApprovals(now.toISOString())
      const waiting = this.#actions.listWaitingForApproval === undefined
        ? (await Promise.all(this.#store.listWorkspaces().flatMap((workspace) =>
          this.#store.listWorlds(workspace.id, true).map((world) => this.#actions.listByWorld(world.id)),
        ))).flat().filter((action) => action.status === 'waiting-for-approval')
        : await this.#actions.listWaitingForApproval()
      for (const action of waiting) {
        if (action.approvalRequestId === undefined) continue
        const request = this.#store.getApprovalRequest(action.approvalRequestId)
        if (request?.status !== 'expired') continue
        action.status = 'rejected'
        action.detail = '该操作未执行，因为审批已过期。'
        action.updatedAt = now.toISOString()
        await this.#discard(action)
        await this.#actions.save(action)
        if (request.workTurnId !== undefined) await this.#approvalSettlementHandler?.(request.workTurnId)
      }
      for (const action of await this.#actions.listDue(now)) {
        const employee = this.#store.getEmployee(action.characterId)
        const revision = employee === undefined ? undefined : this.#store.getEmployeeRevision(employee.id, employee.currentRevision)
        if (
          employee === undefined
          || employee.status === 'archived'
          || employee.worldId !== action.worldId
          || revision === undefined
          || !revision.skillGrants.includes(action.skillId)
        ) {
          action.status = 'failed'
          action.detail = '计划执行前角色已不可用或技能授权已撤销'
          action.updatedAt = now.toISOString()
          await this.#discard(action)
          await this.#actions.save(action)
          continue
        }
        if (await this.#execute(action, now)) await this.#actions.save(action)
      }
    } finally {
      this.#ticking = false
    }
  }

  async executeReadyAction(actionId: string, now = new Date()): Promise<CharacterSkillAction> {
    if (this.#actions.get === undefined) throw new Error('Skill action repository cannot load actions')
    const action = await this.#actions.get(actionId)
    if (action === undefined) throw new Error(`Skill action not found: ${actionId}`)
    if (await this.#execute(action, now)) await this.#actions.save(action)
    return action
  }

  async recoverApprovedActions(now = new Date()): Promise<CharacterSkillAction[]> {
    this.#store.reconcileApprovedSkillActions(now.toISOString())
    const recovered: CharacterSkillAction[] = []
    for (const action of this.#store.listSkillActionsReadyForExecution()) {
      if (action.scheduledFor !== undefined && Date.parse(action.scheduledFor) > now.getTime()) continue
      recovered.push(await this.executeReadyAction(action.id, now))
    }
    return recovered
  }

  async #execute(action: CharacterSkillAction, now: Date): Promise<boolean> {
    if (!this.#isGrantActive(action)) {
      action.status = 'failed'
      action.detail = '执行前角色已不可用或技能授权已撤销'
      action.updatedAt = now.toISOString()
      await this.#discard(action)
      return true
    }
    if (!this.#isApproved(action)) {
      action.status = 'waiting-for-approval'
      action.detail = '外部动作缺少有效审批，已阻止执行'
      action.updatedAt = now.toISOString()
      return true
    }
    if (action.risk === 'external-side-effect' && action.status !== 'waiting-for-integration') {
      action.status = 'waiting-for-integration'
      action.detail = '审批有效，正在通过受信任技能适配器执行'
      action.updatedAt = now.toISOString()
      await this.#actions.save(action)
    }
    if (!this.#isApproved(action)) {
      action.status = 'waiting-for-approval'
      action.detail = '审批在执行前已失效，外部动作未执行'
      action.updatedAt = now.toISOString()
      return true
    }
    const descriptor = this.#registry.descriptorForSkill(action.skillId)
    const adapter = this.#registry.adapterById(action.adapterId) ?? this.#registry.adapterForSkill(action.skillId)
    if (adapter === undefined || descriptor === undefined || descriptor.adapterId !== action.adapterId) {
      action.status = 'failed'
      action.detail = `当前宿主没有提供技能 ${action.skillId} 的受信任适配器`
      action.executionState = 'settled'
      action.executionCompletedAt = now.toISOString()
      action.updatedAt = now.toISOString()
      return true
    }
    const preflight = await adapter.preflight?.(action)
    if (preflight !== undefined && !preflight.ready) {
      action.status = 'waiting-for-integration'
      action.detail = `${preflight.detail ?? '当前 Integration 不可用'}，未发送外部请求`
      action.executionState = 'settled'
      action.executionCompletedAt = now.toISOString()
      action.updatedAt = now.toISOString()
      return true
    }
    if (action.executionState === undefined) Object.assign(action, this.#store.prepareSkillActionExecution(action.id, now.toISOString()))
    if (action.executionState !== 'approved-ready') return false
    const claimed = this.#store.claimSkillActionExecution(action.id, randomUUID(), now.toISOString())
    // Losing this compare-and-set means another executor owns the attempt. The
    // caller must not persist its stale copy over that attempt or its result.
    if (claimed === undefined) return false
    Object.assign(action, claimed)
    try {
      const result = await adapter.execute(action, { now })
      action.status = result.status
      action.detail = result.detail
    } catch {
      // Adapter exceptions are deliberately ambiguous: the provider may have
      // accepted an external side effect before the local process lost the
      // response. Do not turn this into a definitive failure or retry signal.
      action.status = 'outcome-unknown'
      action.detail = '技能适配器执行过程异常，外部动作结果未知；不得自动重试'
    }
    action.executionState = 'settled'
    action.executionCompletedAt = now.toISOString()
    action.updatedAt = now.toISOString()
    return true
  }

  async #discard(action: CharacterSkillAction): Promise<void> {
    const adapter = this.#registry.adapterById(action.adapterId) ?? this.#registry.adapterForSkill(action.skillId)
    await adapter?.discard?.(action).catch(() => undefined)
  }

  #authorize(action: CharacterSkillAction, now: Date): boolean {
    if (action.risk !== 'external-side-effect') return true
    const policy = this.#matchingPolicy(action)
    if (policy !== undefined) {
      action.authorization = 'preapproved-policy'
      action.status = action.scheduledFor === undefined ? 'waiting-for-integration' : 'scheduled'
      action.detail = action.scheduledFor === undefined
        ? '精确授权策略已匹配，正在通过受信任技能适配器执行'
        : `精确授权策略已匹配，将在 ${localTimeLabel(action.scheduledFor)} 尝试执行`
      return true
    }
    const world = this.#store.getWorld(action.worldId)
    if (world === undefined) return false
    const linkedTurn = action.workTurnId === undefined ? undefined : this.#store.getWorkTurn(action.workTurnId)
    const request = this.#store.createApprovalRequest({
      workspaceId: world.workspaceId,
      worldId: action.worldId,
      ...(action.workTurnId === undefined || linkedTurn === undefined ? {} : {
        sessionId: linkedTurn.sessionId,
        workTurnId: action.workTurnId,
      }),
      ...(action.agentRunId === undefined ? {} : { agentRunId: action.agentRunId }),
      characterId: action.characterId,
      subjectType: 'skill-action',
      subjectId: action.id,
      risk: action.risk,
      summary: `${action.label} · ${action.target}`,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
    })
    action.approvalRequestId = request.id
    action.status = 'waiting-for-approval'
    action.detail = '外部动作已安全预留，等待用户审批'
    return false
  }

  #isApproved(action: CharacterSkillAction): boolean {
    if (action.risk !== 'external-side-effect') return true
    if (this.#matchingPolicy(action) !== undefined) return true
    if (action.approvalRequestId === undefined) return false
    const request = this.#store.getApprovalRequest(action.approvalRequestId)
    return request?.status === 'approved'
      && request.subjectType === 'skill-action'
      && request.subjectId === action.id
      && request.worldId === action.worldId
      && request.characterId === action.characterId
  }

  #isGrantActive(action: CharacterSkillAction): boolean {
    const employee = this.#store.getEmployee(action.characterId)
    if (employee === undefined || employee.status === 'archived' || employee.worldId !== action.worldId) return false
    const revision = this.#store.getEmployeeRevision(employee.id, employee.currentRevision)
    return revision !== undefined && revision.skillGrants.includes(action.skillId)
  }

  #matchingPolicy(action: CharacterSkillAction): ApprovalPolicy | undefined {
    if (this.#registry.descriptorForSkill(action.skillId)?.persistentApproval !== 'exact-target') return undefined
    const world = this.#store.getWorld(action.worldId)
    if (world === undefined) return undefined
    return this.#store.findApprovalPolicy({
      workspaceId: world.workspaceId,
      worldId: action.worldId,
      characterId: action.characterId,
      subjectType: 'skill-action',
      skillId: action.skillId,
      action: action.action,
      target: action.target,
      risk: action.risk,
    })
  }
}

function skillSummary(actions: CharacterSkillAction[]): string {
  return actions.map((item) => `${item.label}：${item.detail}`).join('\n')
}

function localTimeLabel(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
