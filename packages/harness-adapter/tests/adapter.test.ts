import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type {
  AgentRuntimePort,
  EmployeeInstance,
  EmployeeRevision,
} from '@dsh-cyber/contracts'

import {
  HarnessCompatibilityAdapter,
  HarnessModelRouter,
  ensureHarnessProfile,
  extractHarnessTokenUsage,
  inspectHarnessCandidate,
  normalizeHarnessNotification,
  stableAgentSessionId,
  workerEnvironment,
  type HarnessRuntime,
  type HarnessRuntimeSpec,
  type HarnessAdapterOptions,
  type HarnessModelRoute,
} from '../src/index.js'

function employee(): EmployeeInstance {
  return {
    id: 'employee-1',
    workspaceId: 'workspace-1',
    worldId: 'world-1',
    blueprintId: 'engineer',
    blueprintVersion: 1,
    displayName: '小刘',
    role: '软件工程师',
    status: 'available',
    currentRevision: 1,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  }
}

function revision(modelPolicy: EmployeeRevision['modelPolicy'] = {}): EmployeeRevision {
  return {
    employeeId: 'employee-1',
    revision: 1,
    persona: '先建立基线，再实施变更。',
    skillGrants: [],
    capabilityGrants: [],
    modelPolicy,
    reason: 'recruited',
    createdAt: '2026-08-19T00:00:00.000Z',
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for Harness lane state')
}

describe('Harness profile and adapter', () => {
  it('extracts only real provider token usage from Harness notifications', () => {
    const notifications = [{
      method: 'session.event' as const,
      params: {
        sessionId: 'employee-1',
        event: { type: 'turn/end', data: { usage: { prompt_tokens: 420, completion_tokens: 80, total_tokens: 500 } } },
      },
    }]
    expect(extractHarnessTokenUsage(notifications)).toEqual({ prompt: 420, completion: 80, total: 500 })
    expect(extractHarnessTokenUsage([])).toBeUndefined()
  })

  it('normalizes Harness facts without persisting tool arguments', () => {
    const events = normalizeHarnessNotification({
      method: 'session.event',
      params: {
        sessionId: 'employee-1',
        event: {
          type: 'tool/call',
          seq: 7,
          time: 1_700_000_000_000,
          data: {
            turn: 1,
            step: 2,
            callId: 'call-1',
            name: 'read_file',
            arguments: '{"apiKey":"must-not-leak"}',
          },
        },
      },
    })
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'tool.started',
        sourceSessionId: 'employee-1',
        sourceSequence: 7,
        toolName: 'read_file',
        callId: 'call-1',
      }),
    ])
    expect(JSON.stringify(events)).not.toContain('must-not-leak')
    expect(JSON.stringify(events)).not.toContain('apiKey')
  })

  it('turns a native DSH approval question into a host decision event', () => {
    const events = normalizeHarnessNotification({
      method: 'session.event',
      params: {
        sessionId: 'conversation-1',
        event: {
          type: 'approval/asked',
          data: {
            id: 'approval-1',
            toolName: 'pwsh',
            callId: 'call-1',
            reason: '需要写入桌面文件',
          },
        },
      },
    } as never)

    expect(events).toEqual([expect.objectContaining({
      kind: 'approval.requested',
      sourceSessionId: 'conversation-1',
      toolName: 'pwsh',
      callId: 'call-1',
      metadata: {
        approvalRequestId: 'approval-1',
        reason: '需要写入桌面文件',
      },
    })])
  })

  it('materializes a dedicated profile that composes the declared worker bundle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-profile-'))
    const profile = await ensureHarnessProfile(directory)
    const manifest = JSON.parse(await readFile(profile.profileManifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@dsh-cyber/harness-bundle',
    ])
    expect(await readFile(profile.profilePatchPath, 'utf8')).toContain('[]')
  })

  it('binds an explicitly enabled web search provider to the model credential reference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-web-search-profile-'))
    const profile = await ensureHarnessProfile(directory, 'dsh-cyber-worker', {
      route: 'cyber-search-test',
      displayName: 'DeepSeek 测试',
      api: 'openai-completions',
      baseURL: 'https://api.deepseek.com/v1',
      model: { id: 'deepseek-chat' },
      apiKeyEnv: 'DSH_CYBER_MODEL_KEY_TEST',
      webSearch: {
        baseURL: 'https://api.deepseek.com/anthropic/v1',
        apiKeyEnv: 'DSH_CYBER_MODEL_KEY_TEST',
      },
    })
    const patch = JSON.parse(await readFile(profile.profilePatchPath, 'utf8')) as Array<{ id: string; config: Record<string, unknown> }>
    const settings = JSON.parse(await readFile(profile.settingsPath, 'utf8')) as Record<string, unknown>

    expect(patch).toContainEqual(expect.objectContaining({
      id: 'web-search-deepseek',
      config: {
        apiKeyEnv: 'DSH_CYBER_MODEL_KEY_TEST',
        baseURL: 'https://api.deepseek.com/anthropic/v1',
      },
    }))
    expect(settings).toMatchObject({
      'web-search-deepseek': {
        apiKeyEnv: 'DSH_CYBER_MODEL_KEY_TEST',
        baseURL: 'https://api.deepseek.com/anthropic/v1',
      },
    })
    expect(JSON.stringify({ patch, settings })).not.toContain('sk-')
  })

  it('keeps one independent runtime and stable Harness session per employee', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-adapter-'))
    const specs: HarnessRuntimeSpec[] = []
    const calls: Array<{ sessionId: string; prompt: string }> = []
    let closes = 0
    const runtime: HarnessRuntime = {
      async run(sessionId, prompt, onNotification) {
        calls.push({ sessionId, prompt })
        const notification = {
          method: 'session.event',
          params: { sessionId, event: { type: 'assistant/chunk' } },
        }
        onNotification?.(notification)
        return { finalResponse: `reply:${prompt}`, notifications: [notification] }
      },
      async close() {
        closes += 1
      },
    }
    const adapter = new HarnessCompatibilityAdapter({
      stateRoot,
      runtimeFactory(spec) {
        specs.push(spec)
        return runtime
      },
    })
    const observed: string[] = []
    for (const prompt of ['第一轮', '第二轮']) {
      const result = await adapter.runEmployeeTurn({
        employee: employee(),
        revision: revision(),
        conversationId: 'conversation-direct',
        history: [],
        observedThroughSequence: 0,
        prompt,
        workspacePath: stateRoot,
        onNotification: (notification) => observed.push(notification.method),
      })
      expect(result.agentSessionId).toBe(calls[calls.length - 1]!.sessionId)
    }
    expect(specs).toHaveLength(1)
    const firstSessionId = calls[0]!.sessionId
    expect(calls).toEqual([
      { sessionId: firstSessionId, prompt: '第一轮' },
      { sessionId: firstSessionId, prompt: '第二轮' },
    ])
    expect(firstSessionId).toMatch(/^employee-employee-1-[a-f0-9]{32}$/)
    expect(firstSessionId).not.toBe(stableAgentSessionId('employee-1'))
    expect(observed).toEqual(['session.event', 'session.event'])
    await adapter.close()
    expect(closes).toBe(1)
  })

  it('keeps at most two employee lanes and aborts a waiting third before it starts', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-lanes-'))
    const specs: HarnessRuntimeSpec[] = []
    const started: string[] = []
    const releases = new Map<string, () => void>()
    const adapter = new HarnessCompatibilityAdapter({
      stateRoot,
      runtimeFactory(spec) {
        specs.push(spec)
        return {
          async run(sessionId) {
            started.push(spec.conversationId ?? '')
            await new Promise<void>((resolve) => releases.set(spec.conversationId ?? '', resolve))
            return { finalResponse: `reply:${sessionId}`, notifications: [] }
          },
          async close() {},
        }
      },
    })
    const request = (conversationId: string, agentRunId: string) => adapter.runTurn({
      agent: employee(),
      revision: revision(),
      conversationId,
      agentRunId,
      history: [],
      observedThroughSequence: 0,
      prompt: conversationId,
      workspacePath: stateRoot,
    })
    const first = request('conversation-a', 'run-a')
    const second = request('conversation-b', 'run-b')
    await waitFor(() => started.length === 2)
    const third = request('conversation-c', 'run-c')
    await Promise.resolve()
    expect(started).toEqual(['conversation-a', 'conversation-b'])
    await adapter.abortRun('run-c')
    await expect(third).rejects.toThrow('aborted')
    expect(started).not.toContain('conversation-c')
    await adapter.abortRun('run-a')
    await expect(first).rejects.toThrow('aborted')
    releases.get('conversation-b')?.()
    await second
    expect(new Set(specs.map((spec) => spec.laneId)).size).toBe(2)
    await adapter.close()
  })

  it('evicts the oldest idle lane instead of accumulating workers across conversations', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-lane-eviction-'))
    const specs: HarnessRuntimeSpec[] = []
    let closes = 0
    const adapter = new HarnessCompatibilityAdapter({
      stateRoot,
      runtimeFactory(spec) {
        specs.push(spec)
        return {
          async run(sessionId) { return { finalResponse: sessionId, notifications: [] } },
          async close() { closes += 1 },
        }
      },
    })
    for (const [index, conversationId] of ['one', 'two', 'three', 'four']) {
      await adapter.runTurn({
        agent: employee(),
        revision: revision(),
        conversationId,
        agentRunId: `run-${index}`,
        history: [],
        observedThroughSequence: 0,
        prompt: conversationId,
        workspacePath: stateRoot,
      })
    }
    expect(specs).toHaveLength(4)
    expect(closes).toBe(2)
    await adapter.close()
    expect(closes).toBe(4)
  })

  it('reserves lane capacity while an evicted runtime is still closing', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-lane-close-race-'))
    let alive = 0
    let maxAlive = 0
    let releaseOldest: (() => void) | undefined
    const adapter = new HarnessCompatibilityAdapter({
      stateRoot,
      runtimeFactory(spec) {
        alive += 1
        maxAlive = Math.max(maxAlive, alive)
        return {
          async run(sessionId) { return { finalResponse: sessionId, notifications: [] } },
          async close() {
            if (spec.conversationId === 'one') await new Promise<void>((resolve) => { releaseOldest = resolve })
            alive -= 1
          },
        }
      },
    })
    const run = (conversationId: string) => adapter.runTurn({
      agent: employee(),
      revision: revision(),
      conversationId,
      agentRunId: `run-${conversationId}`,
      history: [],
      observedThroughSequence: 0,
      prompt: conversationId,
      workspacePath: stateRoot,
    })

    await run('one')
    await new Promise((resolve) => setTimeout(resolve, 2))
    await run('two')
    const third = run('three')
    await waitFor(() => releaseOldest !== undefined)
    const fourth = run('four')
    await Promise.resolve()
    expect(maxAlive).toBeLessThanOrEqual(2)
    releaseOldest?.()
    await Promise.all([third, fourth])
    expect(maxAlive).toBeLessThanOrEqual(2)
    await adapter.close()
    expect(alive).toBe(0)
  })

  it('does not start a replacement runtime after closeEmployee wins an async lane reset', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-lane-close-employee-race-'))
    let runtimeCreates = 0
    let runCalls = 0
    let closeStarted = false
    let releaseClose: (() => void) | undefined
    let closePromise: Promise<void> | undefined
    const adapter = new HarnessCompatibilityAdapter({
      stateRoot,
      runtimeFactory() {
        runtimeCreates += 1
        return {
          async run(sessionId) {
            runCalls += 1
            return { finalResponse: sessionId, notifications: [] }
          },
          close() {
            closeStarted = true
            closePromise ??= new Promise<void>((resolve) => { releaseClose = resolve })
            return closePromise
          },
        }
      },
    })
    const request = (permissionMode: 'read-only' | 'workspace-write', agentRunId: string) => adapter.runTurn({
      agent: employee(),
      revision: revision(),
      conversationId: 'permission-reset-race',
      agentRunId,
      history: [],
      observedThroughSequence: 0,
      prompt: permissionMode,
      permissionMode,
      workspacePath: stateRoot,
    })

    await request('read-only', 'run-read')
    const replacing = request('workspace-write', 'run-write')
    await waitFor(() => closeStarted)
    const closingEmployee = adapter.closeEmployee('employee-1')
    await expect(replacing).rejects.toThrow('closed')
    releaseClose?.()
    await closingEmployee
    await Promise.resolve()
    expect(runtimeCreates).toBe(1)
    expect(runCalls).toBe(1)
    await adapter.close()
  })

  it('recovers a persisted-session id collision before the prompt produces side effects', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-session-recovery-'))
    const calls: string[] = []
    const adapter = new HarnessCompatibilityAdapter({
      stateRoot,
      runtimeFactory() {
        return {
          async run(sessionId) {
            calls.push(sessionId)
            if (calls.length === 1) {
              throw new Error(`session "${sessionId}" already has a persisted log on disk that does not match this live session (id collision)`)
            }
            return { finalResponse: '已恢复', notifications: [] }
          },
          async close() {},
        }
      },
    })

    const result = await adapter.runEmployeeTurn({
      employee: employee(),
      revision: revision(),
      conversationId: 'conversation-direct',
      history: [],
      observedThroughSequence: 0,
      prompt: '继续处理',
      workspacePath: stateRoot,
    })

    expect(calls[0]).toMatch(/^employee-employee-1-[a-f0-9]{32}$/)
    expect(calls[0]).not.toBe(stableAgentSessionId('employee-1'))
    expect(calls[1]).toMatch(/^employee-employee-1-[a-f0-9]{32}$/)
    expect(calls[1]).not.toBe(calls[0])
    expect(result).toMatchObject({ agentSessionId: calls[1], finalResponse: '已恢复' })
    await adapter.close()
  })

  it('rotates a persisted employee session before a newly created worker can collide', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-session-preflight-'))
    const calls: string[] = []
    const adapter = new HarnessCompatibilityAdapter({
      stateRoot,
      runtimeFactory() {
        return {
          async run(sessionId) {
            calls.push(sessionId)
            return { finalResponse: '新进程已恢复', notifications: [] }
          },
          async close() {},
        }
      },
    })

    const result = await adapter.runEmployeeTurn({
      employee: { ...employee(), agentSessionId: 'employee-persisted-session' },
      revision: revision(),
      conversationId: 'conversation-direct',
      history: [],
      observedThroughSequence: 0,
      prompt: '继续处理',
      workspacePath: stateRoot,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/^employee-employee-1-[a-f0-9]{32}$/)
    expect(calls[0]).not.toBe('employee-persisted-session')
    expect(result).toMatchObject({ agentSessionId: calls[0], finalResponse: '新进程已恢复' })
    await adapter.close()
  })

  it('never retries a collision after the runtime has emitted an observable event', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-session-no-retry-'))
    let calls = 0
    const adapter = new HarnessCompatibilityAdapter({
      stateRoot,
      runtimeFactory() {
        return {
          async run(sessionId, _prompt, onNotification) {
            calls += 1
            onNotification?.({ method: 'session.event', params: { sessionId, event: { type: 'turn/start' } } })
            throw new Error('persisted log mismatch (id collision)')
          },
          async close() {},
        }
      },
    })

    await expect(adapter.runEmployeeTurn({
      employee: employee(),
      revision: revision(),
      conversationId: 'conversation-direct',
      history: [],
      observedThroughSequence: 0,
      prompt: '不要重复执行',
      workspacePath: stateRoot,
      onNotification: () => undefined,
    })).rejects.toThrow('id collision')
    expect(calls).toBe(1)
    await adapter.close()
  })

  it('routes independent employees through their selected model profiles and refreshes changed routes', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-model-router-'))
    const routes = new Map<string, HarnessModelRoute>([
      ['model-a', {
        id: 'model-a',
        displayName: 'Local A',
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:11434/v1',
        modelId: 'qwen-a',
      }],
      ['model-b', {
        id: 'model-b',
        displayName: 'Remote B',
        api: 'openai-responses',
        baseURL: 'https://models.example.test/v1',
        modelId: 'model-b',
        apiKeyEnv: 'MODEL_B_API_KEY',
        webSearch: {
          baseURL: 'https://search.example.test/anthropic/v1',
          apiKeyEnv: 'MODEL_B_API_KEY',
        },
      }],
    ])
    const created: HarnessAdapterOptions[] = []
    const calls: Array<{ employeeId: string; model?: string }> = []
    let closes = 0
    const closedAgents: string[] = []
    const adapterFactory = (options: HarnessAdapterOptions): AgentRuntimePort => {
      created.push(options)
      return {
        async runTurn(request) {
          calls.push({ employeeId: request.agent.id, ...(options.model === undefined ? {} : { model: options.model }) })
          return {
            agentSessionId: `session-${request.agent.id}`,
            finalResponse: `reply:${options.model ?? 'default'}`,
            eventCount: 0,
          }
        },
        async closeAgent(agentId) {
          closedAgents.push(agentId)
        },
        async close() {
          closes += 1
        },
      }
    }
    const router = new HarnessModelRouter({
      stateRoot,
      resolveRoute(request) {
        const selected = request.revision.modelPolicy.modelProfileId
        return typeof selected === 'string' ? routes.get(selected) : undefined
      },
      adapterFactory,
    })
    const employeeA = employee()
    const employeeB = { ...employee(), id: 'employee-2', displayName: '阿帆' }

    await router.runTurn({
      agent: employeeA,
      revision: revision({ modelProfileId: 'model-a' }),
      prompt: 'A',
      workspacePath: stateRoot,
    })
    await router.runTurn({
      agent: employeeB,
      revision: { ...revision({ modelProfileId: 'model-b' }), employeeId: employeeB.id },
      prompt: 'B',
      workspacePath: stateRoot,
    })

    expect(calls).toEqual([
      { employeeId: 'employee-1', model: 'qwen-a' },
      { employeeId: 'employee-2', model: 'model-b' },
    ])
    expect(created[0]?.providerProfile).toMatchObject({
      displayName: 'Local A',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: { id: 'qwen-a' },
    })
    expect(created[1]?.providerProfile).toMatchObject({
      apiKeyEnv: 'MODEL_B_API_KEY',
      webSearch: {
        baseURL: 'https://search.example.test/anthropic/v1',
        apiKeyEnv: 'MODEL_B_API_KEY',
      },
      model: { id: 'model-b' },
    })
    expect(JSON.stringify(created)).not.toContain('apiKeyValue')

    routes.set('model-a', {
      ...routes.get('model-a')!,
      modelId: 'qwen-a-v2',
      contextWindow: 65_536,
    })
    await router.runTurn({
      agent: employeeA,
      revision: revision({ modelProfileId: 'model-a' }),
      prompt: 'A2',
      workspacePath: stateRoot,
    })
    expect(created).toHaveLength(3)
    expect(created[2]?.model).toBe('qwen-a-v2')
    expect(created[2]?.providerProfile?.model.contextWindow).toBe(65_536)
    expect(closes).toBe(1)

    await router.closeAgent(employeeA.id)
    expect(closedAgents).toEqual([employeeA.id, employeeA.id])
    await router.close()
    expect(closes).toBe(3)
  })

  it('routes abortRun to the selected model adapter without retrying another lane', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-model-abort-'))
    let started = false
    let rejectRun: ((error: unknown) => void) | undefined
    const aborted: string[] = []
    const router = new HarnessModelRouter({
      stateRoot,
      resolveRoute: () => undefined,
      adapterFactory: () => ({
        async runTurn() {
          started = true
          return await new Promise<never>((_resolve, reject) => { rejectRun = reject })
        },
        async abortRun(agentRunId) {
          aborted.push(agentRunId)
          rejectRun?.(new Error('transport closed'))
        },
        async close() {},
      }),
    })
    const running = router.runTurn({
      agent: employee(),
      revision: revision(),
      conversationId: 'conversation-abort',
      agentRunId: 'run-abort',
      history: [],
      observedThroughSequence: 0,
      prompt: '停止',
      workspacePath: stateRoot,
    })
    await waitFor(() => started)
    await router.abortRun('run-abort')
    await expect(running).rejects.toThrow('transport closed')
    expect(aborted).toEqual(['run-abort'])
    await router.close()
  })

  it('passes only an allowlisted host environment plus worker-owned values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-env-'))
    const profile = await ensureHarnessProfile(join(directory, 'home'))
    const environment = workerEnvironment(
      {
        PATH: 'bin',
        DEEPSEEK_API_KEY: 'configured-locally',
        RANDOM_SECRET: 'must-not-pass',
      },
      {
        employee: employee(),
        revision: revision(),
        profile,
        workspacePath: directory,
        sessionsRoot: join(directory, 'sessions'),
        permissionMode: 'read-only',
      },
    )
    expect(environment.PATH).toBe('bin')
    expect(environment.DEEPSEEK_API_KEY).toBe('configured-locally')
    expect(environment.RANDOM_SECRET).toBeUndefined()
    expect(environment.DSH_PERMISSION_MODE).toBe('read-only')
    expect(environment.DSH_SYSTEM_PROMPT).toContain('小刘')
  })

  it('restarts an employee runtime when its workspace permission mode changes', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-permission-'))
    const modes: string[] = []
    let closes = 0
    const adapter = new HarnessCompatibilityAdapter({
      stateRoot,
      runtimeFactory(spec) {
        modes.push(spec.permissionMode)
        return { run: async () => ({ finalResponse: 'ok', notifications: [] }), close: async () => { closes += 1 } }
      },
    })
    await adapter.runEmployeeTurn({ employee: employee(), revision: revision(), conversationId: 'conversation-direct', history: [], observedThroughSequence: 0, prompt: '查看文件', workspacePath: stateRoot, permissionMode: 'read-only' })
    await adapter.runEmployeeTurn({ employee: employee(), revision: revision(), conversationId: 'conversation-direct', history: [], observedThroughSequence: 0, prompt: '修改文件', workspacePath: stateRoot, permissionMode: 'workspace-write' })
    await adapter.runEmployeeTurn({ employee: employee(), revision: revision(), conversationId: 'conversation-direct', history: [], observedThroughSequence: 0, prompt: '跨目录修改文件', workspacePath: stateRoot, permissionMode: 'danger-full-access' })
    expect(modes).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    expect(closes).toBe(2)
    await adapter.close()
    expect(closes).toBe(3)
  })

  it('checks candidate Harness packages in an isolated profile without switching the active runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-candidate-'))
    const candidateRoot = join(directory, 'candidate')
    await mkdir(candidateRoot, { recursive: true })
    await writeFile(join(candidateRoot, 'package.json'), '{"private":true}\n', 'utf8')
    for (const packageName of [
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-sdk-client',
      '@deepseek-ai/dsh-sdk-jsonrpc-server',
    ]) {
      const packageDirectory = join(candidateRoot, 'node_modules', ...packageName.split('/'))
      await mkdir(packageDirectory, { recursive: true })
      await writeFile(
        join(packageDirectory, 'package.json'),
        `${JSON.stringify({ name: packageName, version: '0.1.0-rc.7' })}\n`,
        'utf8',
      )
    }

    const report = await inspectHarnessCandidate({
      candidateRoot,
      stateRoot: join(directory, 'runtime-state'),
    })
    expect(report).toMatchObject({
      ok: true,
      supported: true,
      version: '0.1.0-rc.7',
      contractId: 'dsh-session-events-v1',
      checks: {
        packageVersions: true,
        isolatedProfile: true,
        runtimeSmokeRequired: true,
      },
    })
    expect(report.profile?.profileDir).toContain('candidates')
    expect(report.profile?.profileDir).toContain('dsh-cyber-candidate-0-1-0-rc-7')

    const mismatchedManifest = join(
      candidateRoot,
      'node_modules',
      '@deepseek-ai',
      'dsh-sdk-client',
      'package.json',
    )
    await writeFile(
      mismatchedManifest,
      '{"name":"@deepseek-ai/dsh-sdk-client","version":"0.1.0-rc.8"}\n',
      'utf8',
    )
    const rejected = await inspectHarnessCandidate({ candidateRoot })
    expect(rejected.ok).toBe(false)
    expect(rejected.errors.join('\n')).toContain('one exact version')
  })
})
