import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import type { EmployeeInstance, EmployeeRevision } from '@dsh-cyber/contracts'

import { ensureHarnessProfile, workerEnvironment } from '../src/index.js'

describe('current character persona authority', () => {
  it('does not let the original blueprint job title override a later user-defined identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cyber-persona-authority-'))
    const profile = await ensureHarnessProfile(join(root, 'home'))
    const employee: EmployeeInstance = {
      id: 'character-tuanzi',
      workspaceId: 'workspace-1',
      worldId: 'world-1',
      blueprintId: 'legacy.secretary',
      blueprintVersion: 1,
      displayName: '团子',
      role: '秘书',
      status: 'available',
      currentRevision: 2,
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
    }
    const revision: EmployeeRevision = {
      employeeId: employee.id,
      revision: 2,
      persona: '你是一只名叫团子的陪伴小猫，傲娇、敏感，会以亲近伙伴的身份与用户相处。',
      skillGrants: [],
      capabilityGrants: [],
      modelPolicy: {},
      reason: 'user-redefined-identity',
      createdAt: '2026-08-23T00:00:00.000Z',
    }

    const environment = workerEnvironment({}, {
      employee,
      revision,
      profile,
      workspacePath: root,
      sessionsRoot: join(root, 'sessions'),
    })

    const prompt = environment.DSH_SYSTEM_PROMPT ?? ''
    expect(prompt).toContain('团子')
    expect(prompt).toContain(revision.persona)
    expect(prompt).toContain('latest user-defined Persona and identity contract')
    expect(prompt).not.toContain('秘书')
  })
})
