import { createHash } from 'node:crypto'

import type {
  AgentRuntimeEvent,
  JsonObject,
  WorldCue,
  WorldInteractionRequest,
  WorldInteractionResult,
  WorldRuntimeSnapshot,
  WorldRuntimeStreamEnvelope,
  WorldThemeManifestV1,
  WorldThemeOption,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'
import {
  cyberCompanyTheme,
  moonlitTavernTheme,
  projectWorldRuntime,
  validateWorldThemeManifest,
} from '@dsh-cyber/world-runtime'

import {
  InstalledPackageVerificationCache,
  loadInstalledWorldThemes,
  readInstalledWorldThemeAsset,
} from './installed-package-runtime.js'

const ACTIVE_RENDERERS = new Set(['pixi-2d'])

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
  readonly #verificationCache = new InstalledPackageVerificationCache()

  constructor(options: WorldRuntimeServiceOptions) {
    this.#store = options.store
    this.#publish = options.publish
    this.#clock = options.clock ?? (() => new Date().toISOString())
  }

  supports(worldId: string): boolean {
    const world = this.#store.getWorld(worldId)
    return world !== undefined && this.#manifestForWorld(world.id, world.templateId) !== undefined
  }

  getSnapshot(worldId: string): WorldRuntimeSnapshot {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    const manifest = this.#manifestForWorld(world.id, world.templateId)
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
    this.#store.saveWorldRuntimeSnapshot(result.snapshot)
    return result.snapshot
  }

  getThemeManifest(worldId: string): WorldThemeManifestV1 {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    const manifest = this.#manifestForWorld(world.id, world.templateId)
    if (manifest === undefined) throw new UnsupportedWorldRuntimeError(worldId)
    const validation = validateWorldThemeManifest(manifest)
    if (!validation.valid) throw new Error(`Built-in world theme is invalid: ${validation.errors.join('; ')}`)
    const binding = this.#store.getWorldThemeBinding(worldId)
    if (
      binding?.status !== 'active' ||
      manifest.id !== binding.themeId ||
      manifest.version !== binding.themeVersion
    ) return manifest
    return {
      ...manifest,
      assets: manifest.assets.map((asset) => ({
        ...asset,
        src: `/api/worlds/${encodeURIComponent(worldId)}/theme-assets/${encodeURIComponent(asset.id)}`,
      })),
    }
  }

  refresh(worldId: string): { snapshot: WorldRuntimeSnapshot; cues: WorldCue[] } {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    const manifest = this.#manifestForWorld(world.id, world.templateId)
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
    this.#store.saveWorldRuntimeSnapshot(result.snapshot)
    return result
  }

  async listThemes(worldId: string): Promise<{ activeThemeId: string; items: WorldThemeOption[] }> {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    const binding = this.#store.getWorldThemeBinding(worldId)
    const builtIn = this.#manifestForTemplate(world.templateId)
    const installed = await loadInstalledWorldThemes(this.#store.listInstalledPackages(world.workspaceId), this.#verificationCache)
    const compatible = installed.filter((item) =>
      themeTemplateMatches(world.templateId, item.manifest.templateId) && ACTIVE_RENDERERS.has(item.manifest.renderer))
    const activeInstalled = binding?.status === 'active'
      ? compatible.find((item) =>
          item.packageId === binding.packageId
          && item.packageVersion === binding.packageVersion
          && item.manifest.id === binding.themeId
          && item.manifest.version === binding.themeVersion
          && item.contentDigest === binding.contentDigest)
      : undefined
    const activeThemeId = activeInstalled?.manifest.id ?? builtIn?.id ?? ''
    const items: WorldThemeOption[] = [
      ...(builtIn === undefined ? [] : [{
        themeId: builtIn.id,
        version: builtIn.version,
        displayName: builtIn.displayName,
        templateId: builtIn.templateId,
        source: 'built-in' as const,
        active: activeInstalled === undefined,
        packageId: '@dsh-cyber/builtin-world-themes',
        packageVersion: builtIn.version,
        contentDigest: themeContentDigest(builtIn),
      }]),
      ...compatible.map((item) => ({
        themeId: item.manifest.id,
        version: item.manifest.version,
        displayName: item.manifest.displayName,
        templateId: item.manifest.templateId,
        source: 'installed' as const,
        active: activeInstalled === item,
        packageId: item.packageId,
        packageVersion: item.packageVersion,
        contentDigest: item.contentDigest,
      })),
    ]
    return { activeThemeId, items }
  }

  async bindInstalledTheme(worldId: string, packageId: string): Promise<WorldRuntimeSnapshot> {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    const themes = await loadInstalledWorldThemes(this.#store.listInstalledPackages(world.workspaceId), this.#verificationCache)
    const selected = themes.find((item) => item.packageId === packageId)
    if (selected === undefined) throw new Error(`Installed world theme not found: ${packageId}`)
    if (!themeTemplateMatches(world.templateId, selected.manifest.templateId)) {
      throw new Error(`World theme ${selected.manifest.id} is not compatible with ${world.templateId}`)
    }
    if (!ACTIVE_RENDERERS.has(selected.manifest.renderer)) {
      throw new Error(`World renderer is not installed: ${selected.manifest.renderer}`)
    }
    this.#store.bindWorldTheme(worldId, {
      packageId: selected.packageId,
      packageVersion: selected.packageVersion,
      themeId: selected.manifest.id,
      themeVersion: selected.manifest.version,
      contentDigest: selected.contentDigest,
    }, selected.manifest)
    const snapshot = this.getSnapshot(worldId)
    this.publishState(snapshot)
    return snapshot
  }

  useBuiltInTheme(worldId: string): WorldRuntimeSnapshot {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    if (this.#manifestForTemplate(world.templateId) === undefined) throw new UnsupportedWorldRuntimeError(worldId)
    this.#store.disableWorldTheme(worldId)
    const snapshot = this.getSnapshot(worldId)
    this.publishState(snapshot)
    return snapshot
  }

  async getThemeAsset(worldId: string, assetId: string): Promise<{ body: Buffer; contentType: string }> {
    const world = this.#store.getWorld(worldId)
    if (world === undefined) throw new Error(`World not found: ${worldId}`)
    const binding = this.#store.getWorldThemeBinding(worldId)
    if (binding?.status !== 'active') throw new Error('The active world theme does not use package assets')
    const asset = binding.manifest.assets.find((item) => item.id === assetId)
    if (asset === undefined) throw new Error(`World theme asset not found: ${assetId}`)
    const packages = this.#store.listInstalledPackages(world.workspaceId)
    const themes = await loadInstalledWorldThemes(packages, this.#verificationCache)
    const selected = themes.find((item) =>
      item.packageId === binding.packageId
      && item.packageVersion === binding.packageVersion
      && item.manifest.id === binding.themeId
      && item.manifest.version === binding.themeVersion
      && item.contentDigest === binding.contentDigest)
    if (selected === undefined) throw new Error('The bound world theme package is no longer active')
    const installed = packages.find((item) => item.packageId === selected.packageId && item.version === selected.packageVersion)
    if (installed === undefined) throw new Error('The bound world theme package is missing')
    return readInstalledWorldThemeAsset(installed, asset.src, this.#verificationCache)
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
    const pending = request.action === 'assign-task' || request.action === 'start-meeting'
    const projected = this.refresh(worldId)
    if (pending) {
      for (const cue of projected.cues) this.publishCue(cue)
      this.publishState(projected.snapshot)
      return {
        accepted: true,
        eventId: requested.id,
        status: 'pending',
        snapshot: projected.snapshot,
        cues: projected.cues,
      }
    }
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
    for (const cue of [...projected.cues, ...final.cues]) this.publishCue(cue)
    this.publishState(final.snapshot)
    return {
      accepted: true,
      eventId: completed.id,
      status: 'completed',
      snapshot: final.snapshot,
      cues: [...projected.cues, ...final.cues],
    }
  }

  publishRuntime(worldId: string, runtime: AgentRuntimeEvent, agentId: string): void {
    if (!this.supports(worldId)) return
    const projected = this.refresh(worldId)
    this.#publish({
      contractVersion: 1,
      id: String(projected.snapshot.sequence),
      worldId,
      sequence: projected.snapshot.sequence,
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
    for (const cue of projected.cues) this.publishCue(cue)
    this.publishState(projected.snapshot)
  }

  publishCurrent(worldId: string): void {
    if (!this.supports(worldId)) return
    const projected = this.refresh(worldId)
    for (const cue of projected.cues) this.publishCue(cue)
    this.publishState(projected.snapshot)
  }

  publishState(snapshot: WorldRuntimeSnapshot): void {
    this.#publish({
      contractVersion: 1,
      id: String(snapshot.sequence),
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
      id: String(cue.sequence),
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
    if (templateId === 'personal-world') {
      return {
        ...cyberCompanyTheme,
        id: 'dsh-cyber.personal.default',
        version: '1.0.0',
        templateId: 'personal-world',
        displayName: '我的世界 · 默认空间',
        terminology: {
          ...cyberCompanyTheme.terminology,
          world: '世界',
          participant: '角色',
          session: '会话',
          milestone: '成长记录',
        },
      }
    }
    if (templateId === 'company' || templateId === 'cyber-company') return cyberCompanyTheme
    if (templateId === 'tavern' || templateId === 'moonlit-tavern') return moonlitTavernTheme
    return undefined
  }

  #manifestForWorld(worldId: string, templateId: string): WorldThemeManifestV1 | undefined {
    const binding = this.#store.getWorldThemeBinding(worldId)
    const world = this.#store.getWorld(worldId)
    const installed = world === undefined || binding?.status !== 'active'
      ? undefined
      : this.#store.listInstalledPackages(world.workspaceId).find((item) =>
        item.status === 'active'
        && item.packageId === binding.packageId
        && item.version === binding.packageVersion
        && item.manifest.files.some((file) => file.sha256 === binding.contentDigest))
    if (installed !== undefined && binding?.status === 'active' && themeTemplateMatches(templateId, binding.manifest.templateId) && ACTIVE_RENDERERS.has(binding.manifest.renderer)) {
      return binding.manifest
    }
    return this.#manifestForTemplate(templateId)
  }
}

function themeContentDigest(manifest: WorldThemeManifestV1): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
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

function themeTemplateMatches(worldTemplateId: string, themeTemplateId: string): boolean {
  if (worldTemplateId === 'personal-world') return true
  if (worldTemplateId === themeTemplateId) return true
  if ([worldTemplateId, themeTemplateId].every((value) => value === 'company' || value === 'cyber-company')) return true
  return [worldTemplateId, themeTemplateId].every((value) => value === 'tavern' || value === 'moonlit-tavern')
}
