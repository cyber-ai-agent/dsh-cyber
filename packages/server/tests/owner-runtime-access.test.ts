import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SqliteStore } from '@dsh-cyber/persistence'

import {
  OwnerRuntimeAccessDeniedError,
  OwnerRuntimeAccessService,
} from '../src/services/owner-runtime-access-service.js'

describe('owner runtime session access grants', () => {
  it('requires explicit confirmation and a selected character', () => {
    const service = new OwnerRuntimeAccessService()
    expect(() => service.issueSession({
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeIds: ['employee-1'],
      confirmed: false,
    })).toThrow(OwnerRuntimeAccessDeniedError)
    expect(() => service.issueSession({
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeIds: [],
      confirmed: true,
    })).toThrow(OwnerRuntimeAccessDeniedError)
  })

  it('keeps a confirmed full-access grant active for the current session', () => {
    const service = new OwnerRuntimeAccessService()
    const grant = service.issueSession({
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeIds: ['employee-1'],
      confirmed: true,
    })
    const input = {
      grantId: grant.id,
      worldId: 'world-1',
      sessionId: 'session-1',
      employeeIds: ['employee-1'],
    }
    expect(service.authorizeSession(input)).toBe(true)
    expect(service.authorizeSession(input)).toBe(true)
    expect(service.authorizeSession({ ...input, sessionId: 'session-2' })).toBe(false)
    expect(service.authorizeSession({ ...input, worldId: 'world-2' })).toBe(false)
    expect(service.authorizeSession({ ...input, employeeIds: ['employee-2'] })).toBe(false)
  })

  it('replaces a prior grant for the same session', () => {
    const service = new OwnerRuntimeAccessService()
    const first = service.issueSession({ worldId: 'world-1', sessionId: 'session-1', employeeIds: ['employee-1'], confirmed: true })
    const second = service.issueSession({ worldId: 'world-1', sessionId: 'session-1', employeeIds: ['employee-2'], confirmed: true })
    expect(service.authorizeSession({ grantId: first.id, worldId: 'world-1', sessionId: 'session-1', employeeIds: ['employee-1'] })).toBe(false)
    expect(service.authorizeSession({ grantId: second.id, worldId: 'world-1', sessionId: 'session-1', employeeIds: ['employee-2'] })).toBe(true)
  })

  it('restores a confirmed grant after the SQLite store and service restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-owner-runtime-access-'))
    const databasePath = join(directory, 'cyber.sqlite')
    let store = await SqliteStore.open(databasePath)
    try {
      const workspace = store.createWorkspace({ name: 'Persistent full access' })
      const world = store.createWorld({ workspaceId: workspace.id, name: 'Persistent world', templateId: 'personal-world' })
      const session = store.createSession({ workspaceId: workspace.id, worldId: world.id, kind: 'direct', title: 'Persistent session' })
      const issued = new OwnerRuntimeAccessService(store).issueSession({
        worldId: world.id,
        sessionId: session.id,
        employeeIds: ['employee-1'],
        confirmed: true,
      })
      store.close()

      store = await SqliteStore.open(databasePath)
      const restarted = new OwnerRuntimeAccessService(store)
      expect(restarted.listWorld(world.id)).toEqual([issued])
      expect(restarted.authorizeSession({
        grantId: issued.id,
        worldId: world.id,
        sessionId: session.id,
        employeeIds: ['employee-1'],
      })).toBe(true)
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
