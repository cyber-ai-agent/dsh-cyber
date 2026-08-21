import { readFile, writeFile } from 'node:fs/promises'

async function patch(path, replacements) {
  let source = await readFile(path, 'utf8')
  for (const [from, to] of replacements) {
    if (!source.includes(from)) {
      throw new Error(`Missing merge anchor in ${path}: ${from.slice(0, 100)}`)
    }
    source = source.replace(from, to)
  }
  if (source.includes('<<<<<<<') || source.includes('=======') || source.includes('>>>>>>>')) {
    throw new Error(`Unresolved conflict markers remain in ${path}`)
  }
  await writeFile(path, source, 'utf8')
}

const pr8 = 'refs/remotes/origin/pr8'

await patch('packages/server/src/server.ts', [
  [
`<<<<<<< HEAD
import type { AgentRuntimePort } from '@dsh-cyber/contracts'
=======
import type { AgentRuntimePort, AgentTurnRequest, ModelProfile } from '@dsh-cyber/contracts'
>>>>>>> ${pr8}`,
`import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'`,
  ],
  [
`  resolveCandidateDshBin,
} from '@dsh-cyber/harness-adapter'`,
`  resolveCandidateDshBin,
  type HarnessModelRoute,
} from '@dsh-cyber/harness-adapter'`,
  ],
  [
`<<<<<<< HEAD
import { ModelCredentialService } from './services/model-credential-service.js'
=======
import {
  ModelInteractionService,
  TurnInteractionLoggingRuntime,
} from './services/model-interaction-service.js'
>>>>>>> ${pr8}`,
`import { ModelCredentialService } from './services/model-credential-service.js'
import {
  ModelInteractionService,
  TurnInteractionLoggingRuntime,
} from './services/model-interaction-service.js'`,
  ],
  [
`<<<<<<< HEAD
      const selectedProfileId = request.revision.modelPolicy.modelProfileId
      const selectedProfile = typeof selectedProfileId === 'string'
        ? store.getModelProfile(selectedProfileId)
        : undefined
      const profile = selectedProfile?.workspaceId === request.agent.workspaceId
        ? selectedProfile
        : store.resolveModelProfile(request.agent.workspaceId, request.agent.worldId, request.agent.id)
      return profile === undefined ? undefined : harnessModelRoute(profile, request.reasoningEffort)
=======
      return resolveHarnessRoute(store, request)
    },
  })
  // 无论内置路由还是外部注入的 runtime，统一包一层回合级日志采集；
  // 观测边界：模型 API 请求在 DSH worker 内部，服务端记录整轮交互的成功/失败与耗时。
  const runtime = new TurnInteractionLoggingRuntime({
    inner: baseRuntime,
    service: interactions,
    resolveRoute(request) {
      return resolveHarnessRoute(store, request)
>>>>>>> ${pr8}`,
`      return resolveHarnessRoute(store, request)
    },
  })
  // 无论内置路由还是外部注入的 runtime，统一包一层回合级日志采集；
  // 观测边界：模型 API 请求在 DSH worker 内部，服务端记录整轮交互的成功/失败与耗时。
  const runtime = new TurnInteractionLoggingRuntime({
    inner: baseRuntime,
    service: interactions,
    resolveRoute(request) {
      return resolveHarnessRoute(store, request)`,
  ],
  [
`<<<<<<< HEAD
  registerWorldRuntimeRoutes(router, { store, worldRuntime, worldStreamHub, worldAccess })
  registerConversationRoutes(router, {
    store,
    orchestrator,
    runtimeStreamHub,
    worldRuntime,
    worldAccess,
    worldSettings,
  })
  registerEmployeeRoutes(router, { store, worldAccess })
=======
  registerWorldRuntimeRoutes(router, { store, worldRuntime, worldStreamHub })
  registerModelInteractionRoutes(router, { store, interactions })
  registerConversationRoutes(router, { store, orchestrator, runtimeStreamHub, worldRuntime })
  registerEmployeeRoutes(router, { store })
>>>>>>> ${pr8}`,
`  registerWorldRuntimeRoutes(router, { store, worldRuntime, worldStreamHub, worldAccess })
  registerModelInteractionRoutes(router, { store, interactions })
  registerConversationRoutes(router, {
    store,
    orchestrator,
    runtimeStreamHub,
    worldRuntime,
    worldAccess,
    worldSettings,
  })
  registerEmployeeRoutes(router, { store, worldAccess })`,
  ],
  [
`<<<<<<< HEAD
=======
function resolveHarnessRoute(store: SqliteStore, request: AgentTurnRequest): HarnessModelRoute | undefined {
  const selectedProfileId = request.revision.modelPolicy.modelProfileId
  const selectedProfile = typeof selectedProfileId === 'string'
    ? store.getModelProfile(selectedProfileId)
    : undefined
  const profile = selectedProfile?.workspaceId === request.agent.workspaceId
    ? selectedProfile
    : store.resolveModelProfile(request.agent.workspaceId, request.agent.worldId, request.agent.id)
  return profile === undefined ? undefined : harnessModelRoute(profile)
}

function harnessModelRoute(profile: ModelProfile): HarnessModelRoute {
  const contextWindow = optionalPositiveInteger(profile.settings.contextWindow)
  const maxTokens = optionalPositiveInteger(profile.settings.maxTokens)
  return {
    id: profile.id,
    displayName: profile.displayName,
    api: profile.api,
    baseURL: profile.baseUrl,
    modelId: profile.modelId,
    ...(profile.credentialEnvName === undefined ? {} : { apiKeyEnv: profile.credentialEnvName }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

>>>>>>> ${pr8}`,
`function resolveHarnessRoute(store: SqliteStore, request: AgentTurnRequest): HarnessModelRoute | undefined {
  const selectedProfileId = request.revision.modelPolicy.modelProfileId
  const selectedProfile = typeof selectedProfileId === 'string'
    ? store.getModelProfile(selectedProfileId)
    : undefined
  const profile = selectedProfile?.workspaceId === request.agent.workspaceId
    ? selectedProfile
    : store.resolveModelProfile(request.agent.workspaceId, request.agent.worldId, request.agent.id)
  return profile === undefined ? undefined : harnessModelRoute(profile, request.reasoningEffort)
}

`,
  ],
])

await patch('packages/web/src/App.tsx', [
  [
`<<<<<<< HEAD
  }, [activeSession, activeSessionId, activeWorld, conversationIntent, employees, messages.length, sessionParticipants, reasoningEffort])
=======
  }, [activeSession, activeSessionId, activeWorld, clearLiveTurns, conversationIntent, employees, messages.length, sessionParticipants])
>>>>>>> ${pr8}`,
`  }, [activeSession, activeSessionId, activeWorld, clearLiveTurns, conversationIntent, employees, messages.length, sessionParticipants, reasoningEffort])`,
  ],
])

await patch('packages/web/src/components/ChatWorkbench.tsx', [
  [
`<<<<<<< HEAD
import { useMemo, useRef, useState } from 'react'
import type { ChatAttachment, JsonObject, ReasoningEffort, WorkMessage, WorkSession, World } from '@dsh-cyber/contracts'
=======
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatAttachment, JsonObject, WorkMessage, WorkSession, World } from '@dsh-cyber/contracts'
>>>>>>> ${pr8}`,
`import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatAttachment, JsonObject, ReasoningEffort, WorkMessage, WorkSession, World } from '@dsh-cyber/contracts'`,
  ],
  [
`<<<<<<< HEAD
        <span>{turn.status === 'failed' ? <WarningCircle size={16} /> : <CircleNotch size={16} className={turn.status === 'completed' ? '' : 'spin'} />}</span>
        <div><strong>{employee?.displayName ?? '角色'}</strong><small>{liveStatusLabel(turn.status)}</small></div>
=======
        <span>{turn.status === 'failed' ? <WarningCircle size={16} /> : <CircleNotch size={16} className={live ? 'spin' : ''} />}</span>
        <div><strong>{employee?.displayName ?? '员工'}</strong><small>{liveStatusLabel(turn.status)}</small></div>
        {live ? <em className="live-turn__badge">实时</em> : null}
>>>>>>> ${pr8}`,
`        <span>{turn.status === 'failed' ? <WarningCircle size={16} /> : <CircleNotch size={16} className={live ? 'spin' : ''} />}</span>
        <div><strong>{employee?.displayName ?? '角色'}</strong><small>{liveStatusLabel(turn.status)}</small></div>
        {live ? <em className="live-turn__badge">实时</em> : null}`,
  ],
])

console.log('PR 8 semantic conflicts resolved.')
