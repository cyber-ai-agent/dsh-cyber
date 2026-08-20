import { randomUUID } from 'node:crypto'

import type {
  AgentRuntimeEvent,
  JsonObject,
  WorldCue,
  WorldInteractionRequest,
  WorldInteractionResult,
  WorldRuntimeSnapshot,
  WorldRuntimeStreamEnvelope,
  WorldThemeManifestV1,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import {
  cyberCompanyTheme,
  projectWorldRuntime,
  validateWorldThemeManifest,
} from '@dsh-cyber/world-runtime'

export class UnsupportedWorldRuntimeError extends Error {
  readonly worldId: string

  constructor(worldId: string) {
    super(`World ${worldId} does not have a World Runtime V2 theme`)
    this.name = 'UnsupportedWorldRuntimeError'
    this.worldId = worldId
  }
}

export interface WorldRuntimeServiceOptions {
  store: SqliteStore
  publish: (event: WorldRuntimeStreamEnvelope) => void
  clock?: () => string
}

export class WorldRuntimeService {
  readonly #store: SqliteStore
  readonly #publish: (event: WorldRuntimeStreamEnvelope) => void
  readonly #clock: () => string

  constructor(options: WorldRuntimeServiceOptions) {
    this.#store = options.store
    this.#publish = options.publish
    this.#clock = options.clock ?? (() => new Date().toISOString())
  }

  supports(worldId: string): boolean {
    const world = this.#store.getWorld(worldId)
    return world !== undefined && this.#manifestForTemplate(world.templateId) !== undefined
  }

  getSnapshot(worldId: string): WorldRuntimeSnapshot {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    const manifest = this.#manifestForTemplate(world.templateId)
    if (manifest === undefined) throw new UnsupportedWorldRuntimeError(worldId)
    const validation = validateWorldThemeManifest(manifest)
    if (!validation.valid) throw new Error(`Built-in world theme is invalid: ${validation.errors.join('; ')}`)
    const previous = this.#store.getWorldRuntimeSnapshot(worldId)
    const events = this.#store.listWorldDomainEvents(worldId, previous?.sequence ?? 0)
    const employees = this.#store.listEmployees(worldId)
    const milestones = employees.flatMap((employee) => this.#store.listEmployeeMilestones(employee.id))
    const result = projectWorldRuntime({
      workspaceId: world.workspaceId,
      world,
      employees,
      events,
      milestones,
      manifest,
      ...(previous === undefined ? {} : { previous }),
      now: this.#clock(),
    })
    this.#store.saveWorldRuntimeSnapshot(result.snapshot, manifest)
    return result.snapshot
  }

  getThemeManifest(worldId: string): WorldThemeManifestV1 {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    const manifest = this.#manifestForTemplate(world.templateId)
    if (manifest === undefined) throw new UnsupportedWorldRuntimeError(worldId)
    const validation = validateWorldThemeManifest(manifest)
    if (!validation.valid) throw new Error(`Built-in world theme is invalid: ${validation.errors.join('; ')}`)
    return manifest
  }

  refresh(worldId: string): { snapshot: WorldRuntimeSnapshot; cues: WorldCue[] } {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    const manifest = this.#manifestForTemplate(world.templateId)
    if (manifest === undefined) throw new UnsupportedWorldRuntimeError(worldId)
    const previous = this.#store.getWorldRuntimeSnapshot(worldId)
    const employees = this.#store.listEmployees(worldId)
    const result = projectWorldRuntime({
      workspaceId: world.workspaceId,
      world,
      employees,
      events: this.#store.listWorldDomainEvents(worldId, previous?.sequence ?? 0),
      milestones: employees.flatMap((employee) => this.#store.listEmployeeMilestones(employee.id)),
      manifest,
      ...(previous === undefined ? {} : { previous }),
      now: this.#clock(),
    })
    this.#store.saveWorldRuntimeSnapshot(result.snapshot, manifest)
    return result
  }

  interact(worldId: string, request: WorldInteractionRequest): WorldInteractionResult {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    const snapshot = this.getSnapshot(worldId)
    this.#assertInteractionTarget(request, snapshot)
    const requested = this.#store.appendDomainEvent({
      workspaceId: world.workspaceId,
      worldId,
      type: 'world.interaction.requested',
      actorId: request.actorId,
      actorKind: request.actorId === 'owner' ? 'owner' : 'employee',
      payload: interactionPayload(request),
    })
    if (request.action === 'toggle-lights') {
      this.#store.appendDomainEvent({
        workspaceId: world.workspaceId,
        worldId,
        type: 'world.lights.changed',
        actorId: request.actorId,
        actorKind: request.actorId === 'owner' ? 'owner' : 'employee',
        causationId: requested.id,
        payload: { lightsOn: !snapshot.clock.lightsOn },
      })
    }
    if (request.action === 'use-object' && request.objectId !== undefined) {
      this.#store.appendDomainEvent({
        workspaceId: world.workspaceId,
        worldId,
        type: 'world.object.activated',
        actorId: request.actorId,
        actorKind: request.actorId === 'owner' ? 'owner' : 'employee',
        causationId: requested.id,
        payload: {
          objectId: request.objectId,
          entityId: request.entityId ?? '',
          label: '对象已接管当前活动',
        },
      })
    }
    if (request.action === 'start-meeting') {
      this.#store.appendDomainEvent({
        workspaceId: world.workspaceId,
        worldId,
        type: 'meeting.started',
        actorId: request.actorId,
        actorKind: request.actorId === 'owner' ? 'owner' : 'employee',
        causationId: requested.id,
        correlationId: requested.id,
        payload: {
          participantIds: request.participantIds ?? [],
          sourceInteractionId: requested.id,
        },
      })
    }
    const projected = this.refresh(worldId)
    const completed = this.#store.appendDomainEvent({
      workspaceId: world.workspaceId,
      worldId,
      type: 'world.interaction.completed',
      actorId: 'system',
      actorKind: 'system',
      causationId: requested.id,
      payload: {
        action: request.action,
        requestedEventId: requested.id,
        entityId: request.entityId ?? '',
        objectId: request.objectId ?? '',
        participantIds: request.participantIds ?? [],
      },
    })
    const final = this.refresh(worldId)
    this.publishState(final.snapshot)
    for (const cue of [...projected.cues, ...final.cues]) this.publishCue(cue)
    return {
      accepted: true,
      eventId: completed.id,
      snapshot: final.snapshot,
      cues: [...projected.cues, ...final.cues],
    }
  }

  publishRuntime(worldId: string, runtime: AgentRuntimeEvent, agentId: string): void {
    if (!this.supports(worldId)) return
    const snapshot = this.getSnapshot(worldId)
    this.#publish({
      contractVersion: 1,
      id: `runtime:${randomUUID()}`,
      worldId,
      sequence: snapshot.sequence,
      kind: 'runtime',
      payload: {
        agentId,
        runtimeKind: runtime.kind,
        content: runtime.content ?? '',
        toolName: runtime.toolName ?? '',
        failed: runtime.failed ?? false,
      },
      createdAt: this.#clock(),
    })
    const projected = this.refresh(worldId)
    this.publishState(projected.snapshot)
    for (const cue of projected.cues) this.publishCue(cue)
  }

  publishState(snapshot: WorldRuntimeSnapshot): void {
    this.#publish({
      contractVersion: 1,
      id: `state:${snapshot.worldId}:${snapshot.sequence}`,
      worldId: snapshot.worldId,
      sequence: snapshot.sequence,
      kind: 'world-state',
      payload: snapshot as unknown as JsonObject,
      createdAt: this.#clock(),
    })
  }

  publishCue(cue: WorldCue): void {
    this.#publish({
      contractVersion: 1,
      id: cue.id,
      worldId: cue.worldId,
      sequence: cue.sequence,
      kind: 'world-cue',
      payload: cue as unknown as JsonObject,
      createdAt: cue.createdAt,
    })
  }

  #assertInteractionTarget(request: WorldInteractionRequest, snapshot: WorldRuntimeSnapshot): void {
    if (request.entityId !== undefined && !snapshot.entities.some((entity) => entity.id === request.entityId)) {
      throw new Error(`World entity not found: ${request.entityId}`)
    }
    if (request.objectId !== undefined && !snapshot.objects.some((object) => object.id === request.objectId)) {
      throw new Error(`World object not found: ${request.objectId}`)
    }
    for (const participantId of request.participantIds ?? []) {
      if (!snapshot.entities.some((entity) => entity.id === participantId)) {
        throw new Error(`Meeting participant not found: ${participantId}`)
      }
    }
  }

  #manifestForTemplate(templateId: string): WorldThemeManifestV1 | undefined {
    return templateId === 'company' || templateId === 'cyber-company'
      ? cyberCompanyTheme
      : undefined
  }
}

function interactionPayload(request: WorldInteractionRequest): JsonObject {
  return {
    action: request.action,
    actorId: request.actorId,
    entityId: request.entityId ?? '',
    objectId: request.objectId ?? '',
    participantIds: request.participantIds ?? [],
    prompt: request.prompt ?? '',
    metadata: request.metadata ?? {},
  }
}
