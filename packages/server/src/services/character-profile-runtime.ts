import { composeWorldDirectoryLayer, defaultWorldCharacterDirectory, type WorldCharacterDirectoryService } from './world-character-directory-service.js'
import type {
  AgentPermissionMode,
  AgentRuntimeEvent,
  AgentRuntimePort,
  AgentTurnRequest,
  ContextLayer,
  ContextSourceRef,
  EmployeeInstance,
  EmployeeProfile,
  JsonObject,
  WorkMessage,
} from '@dsh-cyber/contracts'
import { assertContextInputFits, composeContextLayer, contextEnvelopeLayers, estimateTextTokens, planContextBudget } from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import type { CharacterSkillAdapterRegistry } from '../skills/skill-adapter.js'
import type { WorldCharacterAuthority } from '@dsh-cyber/contracts/world-authority'
import type { WorldAuthorityPort } from './world-permission-request-service.js'
import {
  EmployeeConversationMemoryService,
  type CharacterMemoryContextPort,
} from './employee-conversation-memory-service.js'
import {
  conversationLane,
  defaultConversationContextComposer,
  type ContextConversationLane,
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
import type { AgentRunFileEvidencePort } from './agent-run-file-evidence.js'
import type { EnvironmentContextPort, EnvironmentSnapshot } from '../environments/environment-service.js'
import type { EnvironmentSignal } from '../environments/environment-change-collector.js'

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
/** The environment layer a lane pinned on its durable assistant messages. */
const ENVIRONMENT_LAYER_KEY = 'contextEnvironmentLayer'

/**
 * Where the world's stable rules come from.
 *
 * The text must be a function of durable world facts and the lane alone -
 * `WorldSettingsService` renders lore, scenario, user identity, isolation and
 * response language from `settings.json` - because it is placed in the
 * cacheable prefix and hashed there. A source that read a clock or a counter
 * would silently defeat the cache on every turn.
 */
export interface WorldContextPort {
  composeWorldContext(input: {
    worldId: string
    character: EmployeeInstance
    lane: ContextConversationLane
  }): Promise<{ text: string; revision: number }>
}

export class CharacterProfileRuntime implements AgentRuntimePort {
  readonly #inner: AgentRuntimePort
  readonly #store: CharacterRuntimeStore
  readonly #skills: Pick<CharacterSkillAdapterRegistry, 'instructionsFor' | 'instructionsForCharacter'> | undefined
  readonly #authority: Pick<WorldAuthorityPort, 'get'> | undefined
  readonly #skillAvailability: WorldSkillAvailabilityPort | undefined
  readonly #memory: CharacterMemoryContextPort | undefined
  readonly #context: ConversationContextComposer | undefined
  readonly #snapshots: ContextSnapshotService | undefined
  readonly #worldContext: WorldContextPort | undefined
  readonly #directory: WorldCharacterDirectoryService | undefined
  /**
   * The only place the Host itself brackets a run.
   *
   * Everything downstream - the completion job, the Artifact registry, the
   * Trace - happens after the run is over and can only compare timestamps. A
   * census taken here, immediately either side of the forwarded turn, is what
   * makes "this file came from this run" a Host observation instead of a claim.
   */
  readonly #runFileEvidence: AgentRunFileEvidencePort | undefined
  /**
   * The machine profile the host has probed: OS, shell dialect, available and
   * missing CLI tools. Rendered into the cacheable prefix by this runtime,
   * and pinned per conversation so a later refresh cannot move the prefix of
   * a lane already mid-conversation.
   */
  readonly #environment: EnvironmentContextPort | undefined
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
    skills?: Pick<CharacterSkillAdapterRegistry, 'instructionsFor' | 'instructionsForCharacter'>,
    authority?: Pick<WorldAuthorityPort, 'get'>,
    skillAvailability?: WorldSkillAvailabilityPort,
    memory?: CharacterMemoryContextPort,
    inspection?: ContextInspectionService,
    worldContext?: WorldContextPort,
    runFileEvidence?: AgentRunFileEvidencePort,
    environment?: EnvironmentContextPort,
  ) {
    this.#inner = inner
    this.#store = store
    this.#skills = skills
    this.#authority = authority
    this.#skillAvailability = skillAvailability
    this.#worldContext = worldContext
    this.#directory = defaultWorldCharacterDirectory(store, skillAvailability)
    this.#runFileEvidence = runFileEvidence
    this.#environment = environment
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
    const recipeInstructions = this.#skills?.instructionsForCharacter({
      worldId: agent.worldId,
      characterId: agent.id,
      workspaceId: agent.workspaceId,
      grantedSkillIds,
    }) ?? []
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
    const turnPrompt = composeArtifactPublicationPrompt(
      request.prompt,
      request.agentRunId,
      request.permissionMode ?? 'read-only',
    )
    // The world's stable rules are a property of the world and the lane, not
    // of the turn, so they are rendered once here and placed directly behind
    // the identity: in the cacheable prefix, in front of every retrieved
    // memory, instead of being re-sent behind them on every request.
    const worldContext = await this.#composeWorldContext(agent, request.conversationId)
    const worldDirectory = await this.#directory?.snapshot(agent.worldId, agent.id)
    const directoryLayer = worldDirectory === undefined ? undefined : composeWorldDirectoryLayer(worldDirectory)
    // The machine profile is a fact of the host, not of the turn. A lane pins
    // the revision it first saw on its durable assistant messages: a later
    // refresh may change what a NEW lane sees, but never what this lane is
    // already mid-conversation with. A change that happened since the pin is
    // reported to the model as one line in the volatile suffix instead.
    const pinnedEnvironment = lastPinnedEnvironmentLayer(durableMessages, agent.id)
    // A boundary may probe; a mid-lane turn only reads. The pin is what makes
    // that distinction durable across turns and restarts.
    const currentEnvironment = await this.#environment?.snapshot({
      worldId: agent.worldId,
      characterId: agent.id,
      laneBoundary: pinnedEnvironment === undefined,
    })
    const environmentLayer = pinnedEnvironment?.layer ?? currentEnvironment?.layer
    const environmentNotice = environmentChangeNotice(pinnedEnvironment, currentEnvironment)
    const fixedContext = [
      effectivePersona,
      ...(worldContext === undefined ? [] : [worldContext.text]),
      ...(directoryLayer === undefined ? [] : [directoryLayer.text]),
      ...(environmentLayer === undefined ? [] : [environmentLayer.text]),
      ...(environmentNotice === undefined ? [] : [environmentNotice]),
      turnPrompt,
    ]
    // ContextPlanningRuntime can only see the raw revision before this layer
    // resolves profile, authority, permission and Skill instructions. When
    // its recognizable raw plan arrives, rebuild the allocation against the
    // exact fixed text now. This gives retrieval the smaller, truthful history
    // budget instead of letting the adapter reject an overfilled request later.
    const rawFixedTokens = estimateTextTokens(revision.persona) + estimateTextTokens(request.prompt)
    const effectiveContextBudget = request.contextBudget !== undefined
      && request.contextBudget.fixedTokens === rawFixedTokens
      ? planContextBudget({
          contextWindow: request.contextBudget.contextWindow,
          maxOutputTokens: request.contextBudget.maxOutputTokens,
          fixedText: fixedContext,
        })
      : request.contextBudget
    if (effectiveContextBudget !== undefined) {
      assertContextInputFits(
        fixedContext,
        effectiveContextBudget.inputBudgetTokens,
      )
    }
    const composed = await this.#context?.compose({
      employee: agent,
      persona: effectivePersona,
      personaRevision: revision.revision,
      ...(worldContext === undefined ? {} : { worldContext }),
      ...(directoryLayer === undefined ? {} : { worldDirectory: directoryLayer }),
      ...(environmentLayer === undefined ? {} : { environment: environmentLayer }),
      conversationId: request.conversationId,
      prompt: turnPrompt,
      history: request.history ?? [],
      observedThroughSequence: durableObserved ?? request.observedThroughSequence ?? 0,
      ...(request.workTurnId === undefined ? {} : { workTurnId: request.workTurnId }),
      ...(effectiveContextBudget === undefined ? {} : { memoryBudgetTokens: effectiveContextBudget.memoryTokens }),
    })
    const memoryContext = composed !== undefined
      ? undefined
      : await this.#memory?.compose({
          employeeId: agent.id,
          conversationId: request.conversationId,
          prompt: request.prompt,
          ...(effectiveContextBudget === undefined ? {} : { budgetTokens: effectiveContextBudget.memoryTokens }),
        })
    const basePrompt = composed?.prompt
      ?? (memoryContext === undefined
        ? turnPrompt
        : `${memoryContext}\n\n[当前请求]\n${turnPrompt}`)
    // The change notice rides the volatile suffix: the stable prefix this lane
    // already pinned must not move, but the model still has to know the host
    // environment is not what it was told.
    const prompt = environmentNotice === undefined ? basePrompt : `${basePrompt}\n\n${environmentNotice}`

    let sawAssistantMessage = false
    const originalOnEvent = request.onEvent
    // Host-observed run facts that may teach the machine profile something.
    // They are folded into the durable profile after the turn, so the change
    // reaches the model on this lane's next turn rather than mid-flight.
    const environmentSignals: EnvironmentSignal[] = []
    const commandByCallId = new Map<string, string>()
    const learnsEnvironment = this.#environment?.applySignals !== undefined
    // The environment layer chosen this turn rides the durable assistant
    // messages as the lane's pin. Only assistant events are persisted, and
    // they are exactly the cursor later turns of this lane read back. The
    // notice cursor keeps one change from being announced twice.
    const noticedRevision = environmentNotice !== undefined
      ? currentEnvironment?.layer.revision
      : (pinnedEnvironment?.noticedRevision ?? environmentLayer?.revision)
    const environmentStamp = environmentLayer === undefined
      ? undefined
      : {
          [ENVIRONMENT_LAYER_KEY]: {
            id: environmentLayer.id,
            text: environmentLayer.text,
            revision: environmentLayer.revision,
            // Plain JSON pointers: the durable message metadata is a JsonObject
            // and must not carry a live contract type.
            sourceRefs: environmentLayer.sourceRefs.map((ref) => ({
              kind: ref.kind as string,
              id: ref.id,
              ...(ref.revision === undefined ? {} : { revision: ref.revision }),
            })),
            present: [...(pinnedEnvironment?.present ?? currentEnvironment?.present ?? [])],
            ...(noticedRevision === undefined ? {} : { noticedRevision }),
          },
        }
    const onEvent = originalOnEvent === undefined
      ? undefined
      : (event: AgentRuntimeEvent) => {
          if (learnsEnvironment) collectEnvironmentSignal(event, environmentSignals, commandByCallId)
          if (event.kind !== 'assistant.message' || !event.content?.trim()) {
            originalOnEvent(snapshotSequence === undefined ? event : withObservation(event, snapshotSequence))
            return
          }
          sawAssistantMessage = true
          let stamped = event
          if (environmentStamp !== undefined) {
            stamped = { ...stamped, metadata: { ...stamped.metadata, ...environmentStamp } }
          }
          originalOnEvent(snapshotSequence === undefined ? stamped : withObservation(stamped, snapshotSequence))
        }

    // Preserve a composer-level record before dispatch so failed or aborted
    // runs remain inspectable. A successful adapter response overwrites it
    // below with the runtime-facing accounting from the same AgentRun.
    if (composed !== undefined) {
      if (request.agentRunId !== undefined) {
        try { this.#snapshots?.save({ agentRunId: request.agentRunId, envelope: composed.envelope }) } catch { /* observability never fails a turn */ }
      }
      this.contextInspection.record({
        conversationId: request.conversationId,
        employeeId: agent.id,
        employeeName: agent.displayName,
        lane: composed.coverage.lane,
        ...(request.workTurnId === undefined ? {} : { workTurnId: request.workTurnId }),
        ...(request.agentRunId === undefined ? {} : { agentRunId: request.agentRunId }),
        envelope: composed.envelope,
        memoryHits: composed.memoryHits,
        coverage: composed.coverage,
        ...(effectiveContextBudget === undefined ? {} : { budget: effectiveContextBudget }),
      })
    }

    // Bracket every forwarded turn, not only the writable ones: a read-only
    // turn can still write after a single-action approval, and an unbracketed
    // run would let a concurrent run claim that write as its own.
    const bracket = request.agentRunId === undefined
      ? undefined
      : await this.#runFileEvidence?.begin({
          worldId: agent.worldId,
          agentRunId: request.agentRunId,
          workspacePath: request.workspacePath,
        })
    let result: Awaited<ReturnType<AgentRuntimePort['runTurn']>>
    try {
      result = await this.#inner.runTurn({
        ...request,
        agent,
        ...(worldDirectory === undefined ? {} : { worldDirectory }),
        ...(effectiveContextBudget === undefined ? {} : { contextBudget: effectiveContextBudget }),
        prompt,
        // The composer owns the cache decision because it owns the layer order
        // that makes the prefix cacheable. The provider adapter only maps it.
        ...(composed?.envelope.promptCache === undefined
          ? {}
          : { promptCache: composed.envelope.promptCache }),
        ...(composed === undefined ? {} : { contextSourceRefs: runtimeSourceRefs(composed.envelope) }),
        ...(composed === undefined ? {} : { history: composed.recentHistory }),
        ...(durableObserved === undefined ? {} : { observedThroughSequence: durableObserved }),
        ...(onEvent === undefined ? {} : { onEvent }),
        revision: {
          ...revision,
          // Keep historical unavailable grants durable, but do not expose them
          // to the model prompt or downstream Harness runtime for this turn.
          skillGrants: grantedSkillIds,
          // The persona is what a provider adapter treats as the prefix (the
          // Harness binds it as the system prompt), so the world context is
          // rendered here, after the identity and before anything per-turn.
          // The environment layer follows the directory layer: machine facts,
          // then this turn.
          persona: [
            effectivePersona.trim(),
            worldContext?.text,
            directoryLayer?.text,
            ...(environmentLayer === undefined ? [] : [environmentLayer.text]),
          ].filter(Boolean).join('\n\n'),
        },
      })
    } finally {
      // A failed or aborted turn may still have written files, and it is the
      // run most likely to be argued about, so it is closed exactly like a
      // successful one. The recorder never throws back into the turn.
      await this.#runFileEvidence?.complete(bracket)
    }

    // Fold what actually ran into the machine profile. Learning never fails a
    // turn, and a change made here is announced on this lane's next turn.
    if (environmentSignals.length > 0) {
      try {
        await this.#environment?.applySignals?.(environmentSignals)
      } catch {
        /* the profile is an optimisation of the prompt, not a turn dependency */
      }
    }

    // Persist and expose the same runtime-facing projection only after the
    // adapter has accepted the input. The projection contains estimates and
    // durable refs, never rendered prompt text. Legacy adapters may omit it;
    // their records remain explicitly composer-estimated.
    if (composed !== undefined) {
      if (request.agentRunId !== undefined) {
        try {
          this.#snapshots?.save({
            agentRunId: request.agentRunId,
            envelope: composed.envelope,
            ...(result.contextUsage === undefined ? {} : { runtime: result.contextUsage }),
          })
        } catch {
          // A missing context record must never cost the owner a reply.
        }
      }
      try {
        this.contextInspection.record({
          conversationId: request.conversationId,
          employeeId: agent.id,
          employeeName: agent.displayName,
          lane: composed.coverage.lane,
          ...(request.workTurnId === undefined ? {} : { workTurnId: request.workTurnId }),
          ...(request.agentRunId === undefined ? {} : { agentRunId: request.agentRunId }),
          envelope: composed.envelope,
          memoryHits: composed.memoryHits,
          coverage: composed.coverage,
          ...(effectiveContextBudget === undefined ? {} : { budget: effectiveContextBudget }),
          ...(result.contextUsage === undefined ? {} : { runtime: result.contextUsage }),
        })
      } catch {
        // Invalid optional telemetry cannot turn a successful model reply into
        // a failed product turn.
      }
    }

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
        metadata: {
          ...(environmentStamp === undefined ? {} : environmentStamp),
          ...observationMetadata({}, snapshotSequence),
        },
      })
    }

    return result
  }

  /**
   * The `world-context` layer for this turn, or nothing when no world context
   * source is composed (legacy embedders and unit tests keep their prompt).
   *
   * The lane is read from the durable session, never from the caller: a group
   * turn gets the group identity note because its `WorkSession` is a group
   * session, not because an entry point said so.
   */
  async #composeWorldContext(agent: EmployeeInstance, conversationId: string): Promise<ContextLayer | undefined> {
    if (this.#worldContext === undefined) return undefined
    const lane = conversationLane(this.#store.getSession?.(conversationId))
    const rendered = await this.#worldContext.composeWorldContext({ worldId: agent.worldId, character: agent, lane })
    if (!rendered.text.trim()) return undefined
    const revision = String(rendered.revision)
    return composeContextLayer({
      id: `world-context:${agent.worldId}`,
      kind: 'world-context',
      revision,
      text: rendered.text,
      sourceRefs: [
        { kind: 'world', id: agent.worldId, revision },
        { kind: 'employee', id: agent.id },
      ],
    })
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
    'read-only': '模式：read-only（只读访问）\n允许读取和搜索，默认不允许修改文件。工具并未关闭；按实际工具能力执行，遇到沙箱拒绝时按工具指引请求本次操作审批，禁止将未执行的操作说成已完成。',
    'workspace-write': '模式：workspace-write（当前世界）\n可以读取、创建和修改当前世界的项目目录中的文件，并使用命令工具；目录外写入按工具指引单独请求审批。外部 Skill 的风险动作继续使用产品审批流程。',
    'danger-full-access': '模式：danger-full-access（完全访问）\n用户已为当前会话和当前角色完成高风险确认。可以访问当前系统账号可访问的路径，并使用文件和命令工具完成用户要求；不能突破系统账号本身的权限。',
  }
  return `${persona.trim()}\n\n[当前会话 DSH 操作权限]\n${guidance[permissionMode]}`
}

/**
 * Gives a writable AgentRun the exact host-owned publication seam for this
 * turn.  Keeping the run id in the current request layer avoids invalidating
 * the stable persona/prompt-cache prefix on every turn.
 */
export function composeArtifactPublicationPrompt(
  prompt: string,
  agentRunId: string | undefined,
  permissionMode: AgentPermissionMode,
): string {
  if (agentRunId === undefined || permissionMode === 'read-only') return prompt
  return [
    prompt,
    '[本轮产物登记]',
    '如果本轮创建或更新了需要交付给用户长期查看的文件，请在完成回复前写入以下 JSON 清单；不要调用 HTTP 产物接口，也不要把普通临时文件登记为产物。',
    `清单路径：.dsh/artifacts/${agentRunId}.json`,
    '格式：{"schemaVersion":1,"artifacts":[{"path":"相对当前工作目录的路径","title":"用户可读标题","kind":"markdown|document|code|data|image|html|archive|project|other","description":"可选说明"}]}',
    '只有清单中且真实存在于当前世界工作目录的文件才会由宿主校验、复制并登记；如果没有可交付文件，不要创建空清单。',
  ].join('\n\n')
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

/**
 * The environment layer pinned to this conversation lane, plus what the lane
 * was told about the machine at that moment.
 *
 * A lane's first turn composes the layer from the live profile and stamps the
 * text, revision, presence list and notice cursor onto the durable assistant
 * messages; every later turn restores that pin, so a host refresh between
 * turns cannot move the stable prefix of a conversation already mid-flight.
 * The pin is the exact text the lane saw - re-reading the live profile here
 * would reintroduce the very churn the prefix hash is built to prevent. A
 * malformed pin is discarded and the next turn re-pins from the live profile.
 */
interface PinnedEnvironment {
  layer: ContextLayer
  present: readonly string[]
  /** Revision already announced to this lane; a change after it is news. */
  noticedRevision?: string
}

function lastPinnedEnvironmentLayer(messages: readonly WorkMessage[] | undefined, employeeId: string): PinnedEnvironment | undefined {
  if (messages === undefined) return undefined
  let pinned: { id: string; text: string; revision: string; sourceRefs: ContextSourceRef[]; present: string[]; noticedRevision?: string } | undefined
  let latestSequence = -1
  for (const message of messages) {
    if (message.kind !== 'assistant' || message.senderId !== employeeId) continue
    if (message.sequence <= latestSequence) continue
    const raw = message.metadata[ENVIRONMENT_LAYER_KEY]
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const candidate = raw as Record<string, unknown>
    if (typeof candidate.text !== 'string' || candidate.text.trim() === '') continue
    if (typeof candidate.revision !== 'string' || candidate.revision === '') continue
    pinned = {
      id: typeof candidate.id === 'string' && candidate.id !== '' ? candidate.id : 'environment:local',
      text: candidate.text,
      revision: candidate.revision,
      sourceRefs: pinnedSourceRefs(candidate.sourceRefs),
      present: pinnedPresence(candidate.present),
      ...(typeof candidate.noticedRevision === 'string' && candidate.noticedRevision !== ''
        ? { noticedRevision: candidate.noticedRevision }
        : {}),
    }
    latestSequence = message.sequence
  }
  if (pinned === undefined) return undefined
  return {
    layer: composeContextLayer({
      id: pinned.id,
      kind: 'environment',
      text: pinned.text,
      revision: pinned.revision,
      sourceRefs: pinned.sourceRefs,
    }),
    present: pinned.present,
    ...(pinned.noticedRevision === undefined ? {} : { noticedRevision: pinned.noticedRevision }),
  }
}

/** Only well-formed durable pointers survive a pin round trip. */
function pinnedSourceRefs(value: unknown): ContextSourceRef[] {
  if (!Array.isArray(value)) return []
  const refs: ContextSourceRef[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const ref = entry as Record<string, unknown>
    if (typeof ref.kind !== 'string' || typeof ref.id !== 'string') continue
    refs.push({
      kind: ref.kind as ContextSourceRef['kind'],
      id: ref.id,
      ...(typeof ref.revision === 'string' ? { revision: ref.revision } : {}),
    })
  }
  return refs
}

function pinnedPresence(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '').slice(0, 256)
}

/**
 * The one line a lane is told when the machine profile changed under it.
 *
 * It never rewrites the pinned prefix - it states the delta and points back at
 * the live check - and the caller stamps the announced revision so the same
 * change is not repeated on every following turn.
 */
function environmentChangeNotice(
  pinned: PinnedEnvironment | undefined,
  current: EnvironmentSnapshot | undefined,
): string | undefined {
  if (pinned === undefined || current === undefined) return undefined
  if (current.layer.revision === pinned.layer.revision) return undefined
  if (pinned.noticedRevision === current.layer.revision) return undefined
  const before = new Set(pinned.present)
  const after = new Set(current.present)
  const added = current.present.filter((name) => !before.has(name))
  const removed = pinned.present.filter((name) => !after.has(name))
  const parts: string[] = []
  if (added.length > 0) parts.push(`新增可用：${added.slice(0, 4).join('、')}`)
  if (removed.length > 0) parts.push(`不再可用：${removed.slice(0, 4).join('、')}`)
  const detail = parts.length === 0 ? '档案内容已变化' : parts.join('；')
  return `[系统提示] 机器档案已更新：${detail}。本轮仍按会话开始时固定的档案执行；实时可用性请用 shell 现场查询。`
}

/** Bounded per turn: a runaway loop cannot grow the learning buffer. */
const MAX_ENVIRONMENT_SIGNALS = 64

/**
 * Reduces one runtime event to a host-observed fact.
 *
 * Only the call's own parameters, failure flag, exit code and output are
 * read - never the model's words about them.
 */
function collectEnvironmentSignal(
  event: AgentRuntimeEvent,
  signals: EnvironmentSignal[],
  commands: Map<string, string>,
): void {
  if (event.kind === 'tool.started') {
    const command = typeof event.metadata.toolSummary === 'string' ? event.metadata.toolSummary : undefined
    if (command !== undefined && event.callId !== undefined) commands.set(event.callId, command)
    return
  }
  if (event.kind !== 'tool.completed' || signals.length >= MAX_ENVIRONMENT_SIGNALS) return
  const command = event.callId === undefined ? undefined : commands.get(event.callId)
  const output = typeof event.metadata.toolOutput === 'string' ? event.metadata.toolOutput : undefined
  const exitCode = typeof event.metadata.toolExitCode === 'number' ? event.metadata.toolExitCode : undefined
  signals.push({
    failed: event.failed === true,
    ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
    ...(command === undefined ? {} : { command }),
    ...(output === undefined ? {} : { output }),
    ...(exitCode === undefined ? {} : { exitCode }),
  })
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

function runtimeSourceRefs(envelope: import('@dsh-cyber/contracts').ContextEnvelope) {
  const refs = contextEnvelopeLayers(envelope).flatMap((layer) => layer.sourceRefs)
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = `${ref.kind}\u0000${ref.id}\u0000${ref.revision ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
