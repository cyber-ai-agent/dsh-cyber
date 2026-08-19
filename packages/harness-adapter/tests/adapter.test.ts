import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { EmployeeInstance, EmployeeRevision } from '@dsh-cyber/contracts'

import {
  HarnessCompatibilityAdapter,
  ensureHarnessProfile,
  inspectHarnessCandidate,
  normalizeHarnessNotification,
  stableAgentSessionId,
  workerEnvironment,
  type HarnessRuntime,
  type HarnessRuntimeSpec,
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

function revision(): EmployeeRevision {
  return {
    employeeId: 'employee-1',
    revision: 1,
    persona: '先建立基线，再实施变更。',
    skillGrants: [],
    capabilityGrants: [],
    modelPolicy: {},
    reason: 'recruited',
    createdAt: '2026-08-19T00:00:00.000Z',
  }
}

describe('Harness profile and adapter', () => {
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
        prompt,
        workspacePath: stateRoot,
        onNotification: (notification) => observed.push(notification.method),
      })
      expect(result.agentSessionId).toBe(stableAgentSessionId('employee-1'))
    }
    expect(specs).toHaveLength(1)
    expect(calls).toEqual([
      { sessionId: 'employee-employee-1', prompt: '第一轮' },
      { sessionId: 'employee-employee-1', prompt: '第二轮' },
    ])
    expect(observed).toEqual(['session.event', 'session.event'])
    await adapter.close()
    expect(closes).toBe(1)
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
      },
    )
    expect(environment.PATH).toBe('bin')
    expect(environment.DEEPSEEK_API_KEY).toBe('configured-locally')
    expect(environment.RANDOM_SECRET).toBeUndefined()
    expect(environment.DSH_PERMISSION_MODE).toBe('read-only')
    expect(environment.DSH_SYSTEM_PROMPT).toContain('小刘')
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
