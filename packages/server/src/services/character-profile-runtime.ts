import type {
  AgentPermissionMode,
  AgentRuntimeEvent,
  AgentRuntimePort,
  AgentTurnRequest,
  EmployeeProfile,
  JsonObject,
  WorkMessage,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import type { CharacterSkillAdapterRegistry } from '../skills/skill-adapter.js'
import type { WorldCharacterAuthority } from '@dsh-cyber/contracts/world-authority'
import type { WorldAuthorityPort } from './world-permission-request-service.js'
import {
  EmployeeConversationMemoryService,
  type CharacterMemoryContextPort,
} from './employee-conversation-memory-service.js'
import {
  defaultConversationContextComposer,
  type ConversationContextComposer,
  type ConversationMemoryLayersPort,
} from './conversation-context-composer.js'
import {
  contextSnapshotSequence,
  lastDurableObservation,
} from './employee-observation-runtime.js'
import { ContextInspectionService } from './context-inspection-service.js'
import {
  defaultContextSnapshotService,
  type ContextSnapshotService,
} from './context-snapshot-service.js'
import {
  availableWorldSkillIds,
  type WorldSkillAvailabilityPort,
} from './world-skill-availability.js'

type CharacterRuntimeStore = Pick<
  SqliteStore,
  'getEmployee' | 'getEmployeeRevision' | 'getEmployeeProfile' | 'getWorld'
> & Partial<Pick<
  SqliteStore,
  'getEmployeeDossier' | 'getSession' | 'getWorkTurn' | 'listMessages' | 'appendEmployeeMilestone'
  | 'getLatestTaskCollaborationPlanForSession'
  // Read back the raw messages behind a retrieved memory, and decide which of
  // the older turns an indexed memory can still bring back.
  | 'getMessages' | 'listEmployeeMemoryIndex'
  // Record what this run actually ran with: structure and pointers, no text.
  | 'getAgentRun' | 'saveAgentRunContextSnapshot' | 'getAgentRunContextSnapshot'
  | 'getEmployeeMemoryIndexEntry'
>>

const OBSERVED_THROUGH_KEY = 'contextObservedThroughSequence'
const OBSERVATION_VERSION_KEY = 'contextObservationVersion'

export class CharacterProfileRuntime implements AgentRuntimePort {
  readonly #inner: AgentRuntimePort
  readonly #store: CharacterRuntimeStore
  readonly #skills: Pick<CharacterSkillAdapterRegistry, 'instructionsFor'> | undefined
  readonly #authority: Pick<WorldAuthorityPort, 'get'> | undefined
  readonly #skillAvailability: WorldSkillAvailabilityPort | undefined
  readonly #memory: CharacterMemoryContextPort | undefined
  readonly #context: ConversationContextComposer | undefined
  readonly #snapshots: ContextSnapshotService | undefined
  /**
   * What the Context Inspector reads back.
   *
   * The record is taken here rather than rebuilt later from durable rows: a
   * rebuild would disagree with the real turn about the persona, the permission
   * mode and the retrieval ranking, and the Inspector's whole value is that it
   * does not. It is process-local and owns no durable fact, so the runtime that
   * composed the context is also the natural place to keep the note of it.
   */
  readonly contextInspection: ContextInspectionService

  constructor(
    inner: AgentRuntimePort,
    store: CharacterRuntimeStore,
    skills?: Pick<CharacterSkillAdapterRegistry, 'instructionsFor'>,
    authority?: Pick<WorldAuthorityPort, 'get'>,
    skillAvailability?: WorldSkillAvailabilityPort,
    memory?: CharacterMemoryContextPort,
    inspection?: ContextInspectionService,
  ) {
    this.#inner = inner
    this.#store = store
    this.#skills = skills
    this.#authority = authority
    this.#skillAvailability = skillAvailability
    this.contextInspection = inspection ?? new ContextInspectionService()
    this.#memory = memory ?? defaultMemoryForStore(store)
    this.#context = defaultConversationContextComposer(
      store as Record<string, unknown>,
      this.#memory as ConversationMemoryLayersPort | undefined,
    )
    this.#snapshots = defaultContextSnapshotService(store as Record<string, unknown>)
  }

  async runTurn(request: AgentTurnRequest) {
    // A multi-round collaboration can bind a persistent Agent session during an
    // earlier turn. Always reload the current character and revision so the next
    // turn resumes that session instead of using the stale object captured when
    // the conversation was planned.
    const agent = this.#store.getEmployee(request.agent.id) ?? request.agent
    const revision = this.#store.getEmployeeRevision(agent.id, agent.currentRevision)
      ?? request.revision
    const profile = this.#store.getEmployeeProfile(agent.id)

    const grantedSkillIds = await availableWorldSkillIds(this.#skillAvailability, {
      workspaceId: agent.workspaceId,
      worldId: agent.worldId,
      skillIds: revision.skillGrants,
    })
    const recipeInstructions = this.#skills?.instructionsFor(grantedSkillIds) ?? []
    const profiledPersona = profile === undefined ? revision.persona : composeCharacterPersona(revision.persona, profile)
    // Once the authority service is composed, the compatibility pointer is no
    // longer an authorization source. The fallback only keeps isolated legacy
    // embedders/tests working while they migrate to the authority port.
    const currentAuthority = this.#authority === undefined
      ? undefined
      : await this.#authority.get(agent.worldId, agent.id)
    const persona = this.#authority === undefined
      ? composeWorldAdministratorPersona(
          profiledPersona,
          this.#store.getWorld(agent.worldId)?.administratorEmployeeId === agent.id,
        )
      : composeWorldAuthorityPersona(profiledPersona, currentAuthority)
    const runtimePersona = composeConversationPermissionPersona(persona, request.permissionMode ?? 'read-only')
    const effectivePersona = composeSkillRecipes(runtimePersona, recipeInstructions)

    const durableMessages = this.#store.listMessages?.(request.conversationId)
    const durableObserved = durableMessages === undefined
      ? undefined
      : lastDurableObservation(durableMessages, agent.id)
    const snapshotSequence = durableMessages === undefined
      ? undefined
      : contextSnapshotSequence(durableMessages, request)

    // One composer decides the whole turn context. It owns the memory, task and
    // recent-conversation layers; the runtime lane below only renders the part
    // of the recent window its live Agent session has not observed yet. It is
    // given the same observation cursor the lane will use, so the window can
    // never start after an entry the lane still has to replay.
    const composed = await this.#context?.compose({
      employee: agent,
      persona: effectivePersona,
      personaRevision: revision.revision,
      conversationId: request.conversationId,
      prompt: request.prompt,
      history: request.history ?? [],
      observedThroughSequence: durableObserved ?? request.observedThroughSequence ?? 0,
      ...(request.workTurnId === undefined ? {} : { workTurnId: request.workTurnId }),
      ...(request.contextBudget === undefined ? {} : { memoryBudgetTokens: request.contextBudget.memoryTokens }),
    })
    // The context record is written before the turn runs, so a run that fails
    // or is interrupted still explains what it was given. It is observability:
    // it never fails the turn, and it stores no prompt text.
    if (composed !== undefined && request.agentRunId !== undefined) {
      try {
        this.#snapshots?.save({ agentRunId: request.agentRunId, envelope: composed.envelope })
      } catch {
        // A missing context record must never cost the owner a reply.
      }
    // Recorded before the turn runs, so a run that fails or is aborted still
    // leaves behind the context it was given - that is exactly the turn a user
    // most wants to look at afterwards.
    if (composed !== undefined) {
      this.contextInspection.record({
        conversationId: request.conversationId,
        employeeId: agent.id,
        employeeName: agent.displayName,
        lane: composed.coverage.lane,
        ...(request.workTurnId === undefined ? {} : { workTurnId: request.workTurnId }),
        envelope: composed.envelope,
        memoryHits: composed.memoryHits,
        coverage: composed.coverage,
        ...(request.contextBudget === undefined ? {} : { budget: request.contextBudget }),
      })
    }

    const memoryContext = composed !== undefined
      ? undefined
      : await this.#memory?.compose({
          employeeId: agent.id,
          conversationId: request.conversationId,
          prompt: request.prompt,
          ...(request.contextBudget === undefined ? {} : { budgetTokens: request.contextBudget.memoryTokens }),
        })
    const prompt = composed?.prompt
      ?? (memoryContext === undefined
        ? request.prompt
        : `${memoryContext}\n\n[当前请求]\n${request.prompt}`)

    let sawAssistantMessage = false
    const originalOnEvent = request.onEvent
    const onEvent = originalOnEvent === undefined
      ? undefined
      : (event: AgentRuntimeEvent) => {
          if (event.kind === 'assistant.message' && event.content?.trim()) sawAssistantMessage = true
          originalOnEvent(snapshotSequence === undefined ? event : withObservation(event, snapshotSequence))
        }

    const result = await this.#inner.runTurn({
      ...request,
      agent,
      prompt,
      // The composer owns the cache decision because it owns the layer order
      // that makes the prefix cacheable. The provider adapter only maps it.
      ...(composed?.envelope.promptCache === undefined
        ? {}
        : { promptCache: composed.envelope.promptCache }),
      ...(composed === undefined ? {} : { history: composed.recentHistory }),
      ...(durableObserved === undefined ? {} : { observedThroughSequence: durableObserved }),
      ...(onEvent === undefined ? {} : { onEvent }),
      revision: {
        ...revision,
        // Keep historical unavailable grants durable, but do not expose them
        // to the model prompt or downstream Harness runtime for this turn.
        skillGrants: grantedSkillIds,
        persona: effectivePersona,
      },
    })

    // Some providers return only finalResponse. Emit one assembled event so the
    // orchestrator persists the observation cursor on the durable assistant
    // message. This does not create an extra message when the provider already
    // emitted assistant.message.
    if (
      snapshotSequence !== undefined
      && !sawAssistantMessage
      && result.finalResponse.trim()
      && originalOnEvent !== undefined
    ) {
      originalOnEvent({
        kind: 'assistant.message',
        source: 'host-context-observation',
        sourceSessionId: result.agentSessionId,
        content: result.finalResponse,
        metadata: observationMetadata({}, snapshotSequence),
      })
    }

    return result
  }

  close(): Promise<void> {
    return this.#inner.close()
  }

  abortRun(agentRunId: string): Promise<void> {
    return this.#inner.abortRun?.(agentRunId) ?? Promise.resolve()
  }

  decideApproval(agentRunId: string, approvalRequestId: string, decision: 'approved' | 'rejected'): Promise<void> {
    return this.#inner.decideApproval?.(agentRunId, approvalRequestId, decision)
      ?? Promise.reject(new Error('当前运行时未提供动作审批能力'))
  }
}

export function composeSkillRecipes(persona: string, instructions: readonly string[]): string {
  if (instructions.length === 0) return persona
  return `${persona.trim()}\n\n[已授权的工作方法]\n${instructions.map((item) => `- ${item}`).join('\n')}`
}

export function composeWorldAdministratorPersona(persona: string, isAdministrator: boolean): string {
  if (!isAdministrator) return persona
  return `${persona.trim()}\n\n[世界管理员职责]\n你是当前世界的管理员。你可以在明确授权的角色管理动作中调整本世界其他角色的设定与权限；不得读取或修改其他世界的角色。`
}

/**
 * Adds the durable World authority projection to the model prompt. The
 * projection is deliberately explicit and bounded: it contains only the
 * current role and permission IDs, never a compatibility pointer or another
 * world's data.
 */
export function composeWorldAuthorityPersona(
  persona: string,
  authority: WorldCharacterAuthority | undefined,
): string {
  const role = authority?.role === 'administrator' ? '世界管理员' : '普通角色'
  const grants = authority === undefined || authority.permissionGrants.length === 0
    ? '无'
    : authority.permissionGrants.join('、')
  return `${persona.trim()}\n\n[当前世界职权]\n角色：${role}\n已授予的世界权限：${grants}\n世界管理与业务动作只使用上述权限；本轮文件和命令执行遵循当前会话 DSH 操作权限。`
}

export function composeConversationPermissionPersona(persona: string, permissionMode: AgentPermissionMode): string {
  const guidance: Record<AgentPermissionMode, string> = {
    'read-only': '模式：read-only（请求批准）\n当前工作目录只读；文件写入和命令工具由运行时关闭。需要更高权限时，请在回复中说明所需操作。',
    'workspace-write': '模式：workspace-write（帮我批准）\n可以读取、创建和修改当前工作目录中的文件，也可以使用工作区命令工具。外部 Skill 的风险动作继续使用产品审批流程。',
    'danger-full-access': '模式：danger-full-access（完全访问）\n用户已为当前会话和当前角色完成高风险确认。可以访问当前系统账号可访问的路径，并使用文件和命令工具完成用户要求。',
  }
  return `${persona.trim()}\n\n[当前会话 DSH 操作权限]\n${guidance[permissionMode]}`
}

export function composeCharacterPersona(basePersona: string, profile: EmployeeProfile): string {
  const appearance = profile.appearance
  const relationshipToUser = textValue(appearance.relationshipToUser)
  const addressUserAs = textValue(appearance.addressUserAs)
  const selfReference = textValue(appearance.selfReference)
  const lines: string[] = []

  if (profile.background.trim()) lines.push(`背景：${profile.background.trim()}`)
  if (profile.personalityTraits.length > 0) lines.push(`性格：${profile.personalityTraits.join('、')}`)
  if (relationshipToUser) lines.push(`与用户的关系：${relationshipToUser}`)
  if (addressUserAs) lines.push(`称呼用户为：${addressUserAs}`)
  if (selfReference) lines.push(`自称：${selfReference}`)

  const base = basePersona.trim()
  if (lines.length === 0) return base
  return `${base}${base ? '\n\n' : ''}[当前角色资料]\n${lines.join('\n')}`
}

function defaultMemoryForStore(store: CharacterRuntimeStore): CharacterMemoryContextPort | undefined {
  if (
    typeof store.getEmployeeDossier !== 'function'
    || typeof store.getSession !== 'function'
    || typeof store.getWorkTurn !== 'function'
    || typeof store.listMessages !== 'function'
    || typeof store.appendEmployeeMilestone !== 'function'
  ) return undefined
  return new EmployeeConversationMemoryService(store as SqliteStore)
}

function withObservation(event: AgentRuntimeEvent, sequence: number): AgentRuntimeEvent {
  return { ...event, metadata: observationMetadata(event.metadata, sequence) }
}

function observationMetadata(metadata: JsonObject, sequence: number): JsonObject {
  return {
    ...metadata,
    [OBSERVED_THROUGH_KEY]: sequence,
    [OBSERVATION_VERSION_KEY]: 1,
  }
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
