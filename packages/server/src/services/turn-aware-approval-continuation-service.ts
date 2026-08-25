import type { AgentPermissionMode, ApprovalScope, JsonObject, ReasoningEffort, WorkMessage } from '@dsh-cyber/contracts'
import type { CharacterSkillAction } from '@dsh-cyber/contracts/skill-runtime'
import type { ConversationOrchestrator, ConversationResult, DirectConversationInput } from '@dsh-cyber/orchestration'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { applyInstalledPromptTransforms } from '../installed-package-runtime.js'
import type { CharacterSkillRuntime } from './character-skill-runtime.js'
import type { WorldPackageInstanceService } from './world-package-instance-service.js'
import type { WorldSettingsService } from './world-settings-service.js'
import { PersistenceError } from '@dsh-cyber/persistence'

export interface TurnAwareDirectInput extends DirectConversationInput {
  skillPrompt: string
  transformedPrompt: string
}

export interface TurnAwareConversationResult extends ConversationResult {
  workTurnId: string
  waitingForApproval: boolean
}

/**
 * Owns the durable seam between direct chat, Skill actions and approval.
 * HTTP routes only submit commands; SQLite remains the lifecycle authority.
 */
export class TurnAwareApprovalContinuationService {
  readonly #store: SqliteStore
  readonly #orchestrator: ConversationOrchestrator
  readonly #skills: CharacterSkillRuntime
  readonly #settings: WorldSettingsService
  readonly #worldPackages: WorldPackageInstanceService

  constructor(options: {
    store: SqliteStore
    orchestrator: ConversationOrchestrator
    skills: CharacterSkillRuntime
    settings: WorldSettingsService
    worldPackages: WorldPackageInstanceService
  }) {
    this.#store = options.store
    this.#orchestrator = options.orchestrator
    this.#skills = options.skills
    this.#settings = options.settings
    this.#worldPackages = options.worldPackages
    this.#skills.setApprovalSettlementHandler(async (workTurnId) => { await this.continueIfReady(workTurnId) })
  }

  async direct(input: TurnAwareDirectInput): Promise<TurnAwareConversationResult> {
    const begun = this.#orchestrator.beginDirect(input)
    const skillResult = await this.#skills.prepare({
      workspaceId: input.workspaceId,
      worldId: input.worldId,
      sessionId: begun.session.id,
      workTurnId: begun.workTurn.id,
      characterId: input.employeeId,
      prompt: input.skillPrompt,
    })
    if (skillResult.actions.some((action) => action.status === 'waiting-for-approval')) {
      this.#store.waitWorkTurnForApproval(begun.workTurn.id)
      return { session: begun.session, replies: [], workTurnId: begun.workTurn.id, waitingForApproval: true }
    }
    const result = await this.#orchestrator.continueDirect({
      workTurnId: begun.workTurn.id,
      employeeId: input.employeeId,
      runtimePrompt: await this.#settings.composeRuntimePrompt(
        input.worldId,
        this.#store.getEmployee(input.employeeId)!,
        factualRuntimeSource(input.transformedPrompt, skillResult.actions),
      ),
      previousMessages: begun.previousMessages,
      history: begun.history,
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    })
    return { ...result, workTurnId: begun.workTurn.id, waitingForApproval: false }
  }

  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    scope: ApprovalScope,
    actorId: string,
    now = new Date(),
  ) {
    const decided = await this.#skills.decideApproval(approvalId, decision, scope, actorId, now)
    const continuation = decided.request.workTurnId === undefined
      ? undefined
      : await this.continueIfReady(decided.request.workTurnId, now)
    return { ...decided, ...(continuation === undefined ? {} : { continuation }) }
  }

  async recover(now = new Date()): Promise<void> {
    await this.#skills.recoverApprovedActions(now)
    for (const turn of this.#store.listWorkTurnsByStatus('waiting-approval')) {
      await this.continueIfReady(turn.id, now)
    }
  }

  async continueIfReady(workTurnId: string, now = new Date()): Promise<TurnAwareConversationResult | undefined> {
    const turn = this.#store.getWorkTurn(workTurnId)
    if (turn === undefined || turn.status !== 'waiting-approval') return undefined
    let actions = this.#store.listWorldSkillActions(turn.worldId).filter((action) => action.workTurnId === turn.id)
    if (actions.length === 0 || actions.some((action) => action.status === 'waiting-for-approval')) return undefined

    for (const action of actions) {
      if (action.executionState === 'approved-ready' && !isFutureSchedule(action, now)) {
        await this.#skills.executeReadyAction(action.id, now)
      }
    }
    actions = this.#store.listWorldSkillActions(turn.worldId).filter((action) => action.workTurnId === turn.id)
    if (actions.some((action) => action.executionState === 'executing')) return undefined

    try {
      this.#store.resumeWorkTurnAfterApproval(turn.id)
    } catch (error) {
      if (error instanceof PersistenceError) return undefined
      throw error
    }
    const userMessage = currentTurnUserMessage(this.#store.listMessages(turn.sessionId), turn.id)
    const characterId = actions[0]?.characterId ?? this.#store.listParticipants(turn.sessionId).find((item) => item.kind === 'employee')?.participantId
    const character = characterId === undefined ? undefined : this.#store.getEmployee(characterId)
    if (userMessage === undefined || character === undefined || character.worldId !== turn.worldId) {
      this.#store.failWorkTurn(turn.id, 'approval-continuation-invalid')
      return undefined
    }
    const transformed = await applyInstalledPromptTransforms(
      await this.#worldPackages.listRuntimePackages(turn.worldId),
      userMessage.content,
    )
    const permissionMode = permissionModeFrom(userMessage.metadata)
    const reasoningEffort = reasoningEffortFrom(userMessage.metadata)
    const result = await this.#orchestrator.continueDirect({
      workTurnId: turn.id,
      employeeId: character.id,
      runtimePrompt: await this.#settings.composeRuntimePrompt(turn.worldId, character, factualRuntimeSource(transformed, actions)),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
    return { ...result, workTurnId: turn.id, waitingForApproval: false }
  }
}

function factualRuntimeSource(prompt: string, actions: CharacterSkillAction[]): string {
  if (actions.length === 0) return prompt
  const summary = actions.map((action) => `${action.label}：${action.detail}`).join('\n')
  return `${prompt}\n\n[已授权角色技能的真实执行结果]\n${summary}\n只能根据以上持久化事实说明动作已执行、未执行、等待连接、失败或结果未知。不得自动重试结果未知的外部动作。`
}

function currentTurnUserMessage(messages: WorkMessage[], workTurnId: string): WorkMessage | undefined {
  return messages.findLast((message) => message.kind === 'user' && message.metadata.workTurnId === workTurnId)
}

function isFutureSchedule(action: CharacterSkillAction, now: Date): boolean {
  return action.scheduledFor !== undefined && Date.parse(action.scheduledFor) > now.getTime()
}

function permissionModeFrom(metadata: JsonObject): AgentPermissionMode | undefined {
  const value = metadata.permissionMode
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access' ? value : undefined
}

function reasoningEffortFrom(metadata: JsonObject): Exclude<ReasoningEffort, 'auto'> | undefined {
  const value = metadata.reasoningEffort
  return value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' ? value : undefined
}
