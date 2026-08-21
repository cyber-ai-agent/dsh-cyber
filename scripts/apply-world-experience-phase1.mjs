import { readFile, writeFile } from 'node:fs/promises'

async function patch(path, replacements) {
  let source = await readFile(path, 'utf8')
  for (const [from, to] of replacements) {
    if (!source.includes(from)) throw new Error(`Missing anchor in ${path}: ${from.slice(0, 120)}`)
    source = source.replace(from, to)
  }
  await writeFile(path, source, 'utf8')
}

await patch('packages/world-runtime/src/projector.ts', [
  [
`  EmployeeInstance,
  EmployeeMilestone,`,
`  EmployeeInstance,
  EmployeeMilestone,
  EmployeeProfile,`,
  ],
  [
`  milestones?: EmployeeMilestone[]
  manifest: WorldThemeManifestV1`,
`  milestones?: EmployeeMilestone[]
  profiles?: EmployeeProfile[]
  manifest: WorldThemeManifestV1`,
  ],
  [
`  const entities = new Map<string, WorldRuntimeEntityState>()
  for (const entity of input.previous?.entities ?? []) entities.set(entity.id, cloneEntity(entity))

  const arrivalAnchors`,
`  const entities = new Map<string, WorldRuntimeEntityState>()
  for (const entity of input.previous?.entities ?? []) entities.set(entity.id, cloneEntity(entity))
  const profiles = new Map((input.profiles ?? []).map((profile) => [profile.employeeId, profile]))

  const arrivalAnchors`,
  ],
  [
`    const existing = entities.get(employee.id)
    if (existing !== undefined) {
      existing.displayName = employee.displayName
      existing.role = employee.role
      existing.status = employee.status
      existing.updatedAt = employee.updatedAt
      continue
    }`,
`    const existing = entities.get(employee.id)
    const rosterIndex = characterVisualIndex(employee.id, profiles.get(employee.id))
    if (existing !== undefined) {
      existing.displayName = employee.displayName
      existing.role = employee.role
      existing.status = employee.status
      existing.visualState = { ...existing.visualState, rosterIndex }
      existing.updatedAt = employee.updatedAt
      continue
    }`,
  ],
  [
`    entities.set(employee.id, createEmployeeEntity(employee, scene.id, anchor, index))`,
`    entities.set(employee.id, createEmployeeEntity(employee, scene.id, anchor, index, rosterIndex))`,
  ],
  [
`  placementIndex: number,
): WorldRuntimeEntityState {`,
`  placementIndex: number,
  rosterIndex: number,
): WorldRuntimeEntityState {`,
  ],
  [
`    visualState: { rosterIndex: 0 },`,
`    visualState: { rosterIndex },`,
  ],
  [
`function statusLabel(status: EmployeeInstance['status']): string {`,
`function characterVisualIndex(employeeId: string, profile?: EmployeeProfile): number {
  const configured = profile?.appearance['worldSkinIndex'] ?? profile?.appearance['avatarIndex']
  if (typeof configured === 'number' && Number.isInteger(configured)) return Math.min(7, Math.max(0, configured))
  let hash = 0
  for (const character of employeeId) hash = (hash * 31 + character.charCodeAt(0)) % 8
  return hash
}

function statusLabel(status: EmployeeInstance['status']): string {`,
  ],
])

await patch('packages/server/src/world-runtime-service.ts', [
  [
`    const employees = this.#store.listEmployees(worldId)
    const milestones = employees.flatMap((employee) => this.#store.listEmployeeMilestones(employee.id))
    const result = projectWorldRuntime({`,
`    const employees = this.#store.listEmployees(worldId)
    const profiles = employees.flatMap((employee) => {
      const profile = this.#store.getEmployeeProfile(employee.id)
      return profile === undefined ? [] : [profile]
    })
    const milestones = employees.flatMap((employee) => this.#store.listEmployeeMilestones(employee.id))
    const result = projectWorldRuntime({`,
  ],
  [
`      employees,
      events,
      milestones,
      manifest,`,
`      employees,
      events,
      milestones,
      profiles,
      manifest,`,
  ],
  [
`    const previous = this.#store.getWorldRuntimeSnapshot(worldId)
    const employees = this.#store.listEmployees(worldId)
    const result = projectWorldRuntime({`,
`    const previous = this.#store.getWorldRuntimeSnapshot(worldId)
    const employees = this.#store.listEmployees(worldId)
    const profiles = employees.flatMap((employee) => {
      const profile = this.#store.getEmployeeProfile(employee.id)
      return profile === undefined ? [] : [profile]
    })
    const result = projectWorldRuntime({`,
  ],
  [
`      employees,
      events: this.#store.listWorldDomainEvents(worldId, previous?.sequence ?? 0),
      milestones: employees.flatMap((employee) => this.#store.listEmployeeMilestones(employee.id)),
      manifest,`,
`      employees,
      events: this.#store.listWorldDomainEvents(worldId, previous?.sequence ?? 0),
      milestones: employees.flatMap((employee) => this.#store.listEmployeeMilestones(employee.id)),
      profiles,
      manifest,`,
  ],
])

await patch('packages/web/src/features/world/renderer/pixi-world-renderer.ts', [
  [
`  fitScene(): void {
    if (!this.#scene || !this.#host || !this.#initialized) return
    const availableWidth = Math.max(this.#host.clientWidth, 1)
    const availableHeight = Math.max(this.#host.clientHeight, 1)
    this.#fitScale = Math.min(availableWidth / this.#scene.size.width, availableHeight / this.#scene.size.height)
    this.#zoom = 1
    this.#cameraOffset = {
      x: (availableWidth - this.#scene.size.width * this.#fitScale) / 2,
      y: (availableHeight - this.#scene.size.height * this.#fitScale) / 2,
    }
    this.#applyCamera()
  }`,
`  fitScene(): void {
    // “适应窗口”仍然保证视口落在主题声明的 cameraBounds 内，避免拖拽/缩放露出黑边。
    this.fillScene()
  }`,
  ],
  [
`  zoomBy(delta: number): void {
    this.#zoom = clamp(this.#zoom + delta, WORLD_MIN_ZOOM, WORLD_MAX_ZOOM)
    this.#applyCamera()
  }`,
`  zoomBy(delta: number): void {
    const minimum = this.#minimumZoomForCoverage()
    this.#zoom = clamp(this.#zoom + delta, minimum, WORLD_MAX_ZOOM)
    this.#applyCamera()
  }`,
  ],
  [
`      this.#cameraOffset = {
        x: this.#drag.offsetX + event.global.x - this.#drag.x,
        y: this.#drag.offsetY + event.global.y - this.#drag.y,
      }
      this.#applyCamera()`,
`      this.#cameraOffset = {
        x: this.#drag.offsetX + event.global.x - this.#drag.x,
        y: this.#drag.offsetY + event.global.y - this.#drag.y,
      }
      this.#applyCamera()`,
  ],
  [
`  #applyCamera(): void {
    const scale = this.#fitScale * this.#zoom
    this.#camera.scale.set(scale)
    this.#camera.position.set(this.#cameraOffset.x, this.#cameraOffset.y)
  }`,
`  #minimumZoomForCoverage(): number {
    if (!this.#scene || !this.#host || this.#fitScale <= 0) return WORLD_MIN_ZOOM
    const bounds = this.#scene.cameraBounds ?? { x: 0, y: 0, width: this.#scene.size.width, height: this.#scene.size.height }
    const widthZoom = this.#host.clientWidth / Math.max(1, bounds.width * this.#fitScale)
    const heightZoom = this.#host.clientHeight / Math.max(1, bounds.height * this.#fitScale)
    return clamp(Math.max(WORLD_MIN_ZOOM, widthZoom, heightZoom), WORLD_MIN_ZOOM, WORLD_MAX_ZOOM)
  }

  #clampCameraOffset(scale: number): void {
    if (!this.#scene || !this.#host) return
    const bounds = this.#scene.cameraBounds ?? { x: 0, y: 0, width: this.#scene.size.width, height: this.#scene.size.height }
    const viewportWidth = Math.max(1, this.#host.clientWidth)
    const viewportHeight = Math.max(1, this.#host.clientHeight)
    const minX = viewportWidth - (bounds.x + bounds.width) * scale
    const maxX = -bounds.x * scale
    const minY = viewportHeight - (bounds.y + bounds.height) * scale
    const maxY = -bounds.y * scale
    this.#cameraOffset = {
      x: minX <= maxX ? clamp(this.#cameraOffset.x, minX, maxX) : (viewportWidth - bounds.width * scale) / 2 - bounds.x * scale,
      y: minY <= maxY ? clamp(this.#cameraOffset.y, minY, maxY) : (viewportHeight - bounds.height * scale) / 2 - bounds.y * scale,
    }
  }

  #applyCamera(): void {
    this.#zoom = Math.max(this.#zoom, this.#minimumZoomForCoverage())
    const scale = this.#fitScale * this.#zoom
    this.#clampCameraOffset(scale)
    this.#camera.scale.set(scale)
    this.#camera.position.set(this.#cameraOffset.x, this.#cameraOffset.y)
  }`,
  ],
])

await patch('packages/web/src/features/world/WorldRuntimeDock.tsx', [
  [
`import { useState } from 'react'
import type { World, WorldZoomCommand } from '@dsh-cyber/contracts'`,
`import { useEffect, useState } from 'react'
import type { World, WorldInteractionAction, WorldZoomCommand } from '@dsh-cyber/contracts'`,
  ],
  [
`import { createZoomCommand } from './zoom-command.js'`,
`import { createZoomCommand } from './zoom-command.js'
import { EmployeeInteractionMenu, ObjectInteractionMenu } from './WorldInteractionMenu.js'`,
  ],
  [
`  onSelectEmployee(employeeId: string): void
  onRecruit(): void`,
`  onSelectEmployee(employeeId: string): void
  onOpenDossier(employeeId: string): void
  onRecruit(): void`,
  ],
  [
`  onSelectEmployee,
  onRecruit,`,
`  onSelectEmployee,
  onOpenDossier,
  onRecruit,`,
  ],
  [
`  const [selectedObjectId, setSelectedObjectId] = useState<string>()`,
`  const [selectedObjectId, setSelectedObjectId] = useState<string>()
  const [activeEmployeeId, setActiveEmployeeId] = useState<string | undefined>(selectedEmployeeId)
  useEffect(() => setActiveEmployeeId(selectedEmployeeId), [selectedEmployeeId])`,
  ],
  [
`  const focusedNames = conversationEmployeeIds`,
`  const selectedEmployee = employees.find((employee) => employee.id === activeEmployeeId)
  const selectedObject = runtime.snapshot.objects.find((object) => object.id === selectedObjectId)
  const selectedObjectManifest = runtime.manifest.scenes
    .find((scene) => scene.id === runtime.snapshot?.sceneId)
    ?.interactables.find((object) => object.id === selectedObjectId)

  const interactWithEmployee = async (action: 'talk' | 'assign-task' | 'start-meeting') => {
    if (selectedEmployee === undefined) return
    if (action === 'talk') {
      await runtime.interact({ action, actorId: 'owner', entityId: selectedEmployee.id })
      onSelectEmployee(selectedEmployee.id)
      return
    }
    if (action === 'assign-task') {
      await runtime.interact({ action, actorId: 'owner', entityId: selectedEmployee.id, objectId: 'workstation' })
      onSelectEmployee(selectedEmployee.id)
      return
    }
    const colleague = employees.find((employee) => employee.id !== selectedEmployee.id)
    await runtime.interact({
      action,
      actorId: 'owner',
      participantIds: colleague === undefined ? [selectedEmployee.id] : [selectedEmployee.id, colleague.id],
    })
  }

  const actOnObject = async (action: WorldInteractionAction) => {
    if (selectedObject === undefined) return
    const participantIds = action === 'start-meeting'
      ? (selectedEmployee === undefined ? employees.slice(0, 3) : [selectedEmployee, ...employees.filter((employee) => employee.id !== selectedEmployee.id).slice(0, 2)]).map((employee) => employee.id)
      : undefined
    await runtime.interact({
      action,
      actorId: 'owner',
      objectId: selectedObject.id,
      ...(selectedEmployee === undefined ? {} : { entityId: selectedEmployee.id }),
      ...(participantIds === undefined ? {} : { participantIds }),
    })
    if (action === 'assign-task' && selectedEmployee !== undefined) onSelectEmployee(selectedEmployee.id)
  }

  const focusedNames = conversationEmployeeIds`,
  ],
  [
`          {...(selectedEmployeeId === undefined ? {} : { selectedEntityId: selectedEmployeeId })}`, 
`          {...(activeEmployeeId === undefined ? {} : { selectedEntityId: activeEmployeeId })}`,
  ],
  [
`          onEntitySelect={onSelectEmployee}
          onObjectSelect={setSelectedObjectId}`, 
`          onEntitySelect={(employeeId) => { setActiveEmployeeId(employeeId); setSelectedObjectId(undefined) }}
          onObjectSelect={setSelectedObjectId}`,
  ],
  [
`        <div className="world-runtime-dock__controls" aria-label="世界视图控制">`,
`        {selectedEmployee === undefined ? null : (
          <EmployeeInteractionMenu
            employee={selectedEmployee}
            onClose={() => setActiveEmployeeId(undefined)}
            onTalk={() => void interactWithEmployee('talk')}
            onAssignTask={() => void interactWithEmployee('assign-task')}
            onMeeting={() => void interactWithEmployee('start-meeting')}
            onDossier={() => onOpenDossier(selectedEmployee.id)}
          />
        )}

        {selectedObject === undefined || selectedObjectManifest === undefined ? null : (
          <ObjectInteractionMenu
            object={selectedObject}
            manifest={selectedObjectManifest}
            {...(selectedEmployee === undefined ? {} : { selectedEmployee })}
            onClose={() => setSelectedObjectId(undefined)}
            onAction={(action) => void actOnObject(action)}
          />
        )}

        <div className="world-runtime-dock__controls" aria-label="世界视图控制">`,
  ],
])

await patch('packages/web/src/App.tsx', [
  [
`          appearance: { ...(previous?.appearance ?? {}), avatarIndex: input.avatarIndex },`,
`          appearance: { ...(previous?.appearance ?? {}), avatarIndex: input.avatarIndex, worldSkinIndex: input.avatarIndex },`,
  ],
  [
`            appearance: { ...(previous?.appearance ?? {}), avatarIndex: input.avatarIndex },`,
`            appearance: { ...(previous?.appearance ?? {}), avatarIndex: input.avatarIndex, worldSkinIndex: input.avatarIndex },`,
  ],
  [
`      setDossiers((current) => {
        const dossier = current[managingEmployee.id]
        return dossier === undefined
          ? current
          : { ...current, [managingEmployee.id]: { ...dossier, employee: { ...dossier.employee, displayName: input.displayName, updatedAt }, ...(profile === undefined ? {} : { profile }) } }
      })`,
`      setDossiers((current) => {
        const dossier = current[managingEmployee.id]
        return dossier === undefined
          ? current
          : { ...current, [managingEmployee.id]: { ...dossier, employee: { ...dossier.employee, displayName: input.displayName, updatedAt }, ...(profile === undefined ? {} : { profile }) } }
      })
      setWorldRuntimeRevision((value) => value + 1)`,
  ],
  [
`                  onSelectEmployee={(employeeId) => {
                    const employee = employees.find((item) => item.id === employeeId)
                    if (employee !== undefined) directEmployee(employee)
                  }}
                  onRecruit={() => void openRecruitment()}`, 
`                  onSelectEmployee={(employeeId) => {
                    const employee = employees.find((item) => item.id === employeeId)
                    if (employee !== undefined) directEmployee(employee)
                  }}
                  onOpenDossier={(employeeId) => void openDossier(employeeId)}
                  onRecruit={() => void openRecruitment()}`,
  ],
  [
`          blueprints={blueprints}
          world={activeWorld}
          loading={catalogLoading}`, 
`          blueprints={blueprints}
          world={activeWorld}
          employees={employees}
          loading={catalogLoading}`,
  ],
  [
`function stableAvatar(id: string, fallback: number): number {
  let total = fallback
  for (const character of id) total = (total * 31 + character.charCodeAt(0)) % 8
  return total
}`, 
`function stableAvatar(id: string, _fallback: number): number {
  let total = 0
  for (const character of id) total = (total * 31 + character.charCodeAt(0)) % 8
  return total
}`,
  ],
])

await patch('packages/web/src/components/RecruitmentDialog.tsx', [
  [
`import type { EmployeeBlueprint, World } from '@dsh-cyber/contracts'`,
`import type { EmployeeBlueprint, EmployeeInstance, World } from '@dsh-cyber/contracts'`,
  ],
  [
`  world: World
  loading: boolean`,
`  world: World
  employees: EmployeeInstance[]
  loading: boolean`,
  ],
  [
`  world,
  loading,`,
`  world,
  employees,
  loading,`,
  ],
  [
`  const selected = useMemo(
    () => blueprints.find((blueprint) => blueprintKey(blueprint) === selectedKey) ?? blueprints[0],
    [blueprints, selectedKey],
  )`,
`  const selected = useMemo(
    () => blueprints.find((blueprint) => blueprintKey(blueprint) === selectedKey) ?? blueprints[0],
    [blueprints, selectedKey],
  )
  const selectedExisting = selected === undefined
    ? []
    : employees.filter((employee) => employee.blueprintId === selected.id && employee.blueprintVersion === selected.version)
  const duplicateName = (displayName.trim() || selected?.displayName || '').trim()
  const duplicateNameExists = duplicateName !== '' && employees.some((employee) => employee.displayName === duplicateName)`,
  ],
  [
`                  <span>{blueprint.role}</span>
                  <small>{blueprint.summary}</small>`,
`                  <span>{blueprint.role}</span>
                  <small>{blueprint.summary}</small>
                  {employees.some((employee) => employee.blueprintId === blueprint.id && employee.blueprintVersion === blueprint.version)
                    ? <small className="blueprint-card__existing">当前世界已创建 {employees.filter((employee) => employee.blueprintId === blueprint.id && employee.blueprintVersion === blueprint.version).length} 名</small>
                    : null}`,
  ],
  [
`                <p className="blueprint-detail__summary">{selected.summary}</p>`,
`                <p className="blueprint-detail__summary">{selected.summary}</p>
                {selectedExisting.length > 0 ? <div className="permission-notice"><IdentificationCard size={18} /><p>当前世界已经有 {selectedExisting.length} 名角色使用这份蓝图：{selectedExisting.map((employee) => employee.displayName).join('、')}。仍可创建新的独立角色实例。</p></div> : null}`, 
  ],
  [
`                  <input value={displayName} placeholder={selected.displayName} onChange={(event) => setDisplayName(event.target.value)} />`,
`                  <input value={displayName} placeholder={selectedExisting.length > 0 ? `${selected.displayName} ${selectedExisting.length + 1}` : selected.displayName} onChange={(event) => setDisplayName(event.target.value)} />
                  {duplicateNameExists ? <small className="dialog-field__warning">当前世界已有同名角色，建议换一个称呼以便区分。</small> : null}`,
  ],
  [
`              {recruiting ? '正在创建独立 Agent…' : roleplay ? '邀请角色入场' : '确认招聘'}`, 
`              {recruiting ? '正在创建独立角色…' : selectedExisting.length > 0 ? '再创建一名' : roleplay ? '邀请角色入场' : '确认添加'}`,
  ],
])

await patch('packages/world-runtime/tests/world-runtime.test.ts', [
  [
`import type { DomainEvent, EmployeeInstance, World } from '@dsh-cyber/contracts'`,
`import type { DomainEvent, EmployeeInstance, EmployeeProfile, World } from '@dsh-cyber/contracts'`,
  ],
  [
`describe('world theme manifest', () => {`,
`describe('character visual projection', () => {
  it('uses the persisted character appearance for the world skin and keeps characters distinct', () => {
    const profiles: EmployeeProfile[] = employees.map((employee, index) => ({
      employeeId: employee.id,
      revision: 1,
      background: employee.role,
      personalityTraits: [],
      appearance: { avatarIndex: index + 2, worldSkinIndex: index + 2 },
      reason: 'test',
      createdAt: employee.createdAt,
    }))
    const result = projectWorldRuntime({
      workspaceId: world.workspaceId,
      world,
      employees,
      profiles,
      events: [],
      manifest: cyberCompanyTheme,
      now: '2026-08-20T00:00:10.000Z',
    })
    expect(result.snapshot.entities.map((entity) => entity.visualState['rosterIndex'])).toEqual([2, 3])
  })
})

describe('world theme manifest', () => {`,
  ],
])

console.log('World experience phase 1 transforms applied.')
