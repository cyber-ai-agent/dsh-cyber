import type { EmployeeStatus, IsoTimestamp } from './index.js'

/** A character's role is scoped to one World, never to the application. */
export type WorldCharacterRole = 'member' | 'administrator'

export const WORLD_CHARACTER_ROLES = ['member', 'administrator'] as const

export type WorldCharacterPermission =
  | 'world.files.read'
  | 'world.files.write'
  | 'world.settings.read'
  | 'world.settings.write'
  | 'world.characters.read'
  | 'world.characters.manage'
  | 'world.permissions.read'
  | 'world.permissions.manage'
  | 'world.packages.read'
  | 'world.packages.manage'
  | 'world.integrations.read'
  | 'world.integrations.manage'
  | 'world.model.read'
  | 'world.model.assign'
  | 'world.approvals.read'
  | 'world.trace.read'
  | 'world.conversations.read-metadata'
  | 'world.conversations.read-content'

export const WORLD_CHARACTER_PERMISSIONS = [
  'world.files.read',
  'world.files.write',
  'world.settings.read',
  'world.settings.write',
  'world.characters.read',
  'world.characters.manage',
  'world.permissions.read',
  'world.permissions.manage',
  'world.packages.read',
  'world.packages.manage',
  'world.integrations.read',
  'world.integrations.manage',
  'world.model.read',
  'world.model.assign',
  'world.approvals.read',
  'world.trace.read',
  'world.conversations.read-metadata',
  'world.conversations.read-content',
] as const satisfies readonly WorldCharacterPermission[]

export type WorldCharacterPermissionCategory =
  | 'files'
  | 'settings'
  | 'characters'
  | 'extensions'
  | 'models'
  | 'audit'
  | 'conversations'

export interface WorldCharacterPermissionDescriptor {
  id: WorldCharacterPermission
  category: WorldCharacterPermissionCategory
  /** Whether this permission changes or delegates world control. */
  management: boolean
  /** Whether granting it exposes content that needs an explicit confirmation. */
  sensitive: boolean
}

/**
 * The one shared permission vocabulary used by persistence, the server and
 * clients. Keep this ordered for stable API responses and audit payloads.
 */
export const WORLD_CHARACTER_PERMISSION_DESCRIPTORS = [
  { id: 'world.files.read', category: 'files', management: false, sensitive: false },
  { id: 'world.files.write', category: 'files', management: false, sensitive: false },
  { id: 'world.settings.read', category: 'settings', management: false, sensitive: false },
  { id: 'world.settings.write', category: 'settings', management: true, sensitive: false },
  { id: 'world.characters.read', category: 'characters', management: false, sensitive: false },
  { id: 'world.characters.manage', category: 'characters', management: true, sensitive: false },
  { id: 'world.permissions.read', category: 'characters', management: false, sensitive: false },
  { id: 'world.permissions.manage', category: 'characters', management: true, sensitive: false },
  { id: 'world.packages.read', category: 'extensions', management: false, sensitive: false },
  { id: 'world.packages.manage', category: 'extensions', management: true, sensitive: false },
  { id: 'world.integrations.read', category: 'extensions', management: false, sensitive: false },
  { id: 'world.integrations.manage', category: 'extensions', management: true, sensitive: false },
  { id: 'world.model.read', category: 'models', management: false, sensitive: false },
  { id: 'world.model.assign', category: 'models', management: true, sensitive: false },
  { id: 'world.approvals.read', category: 'audit', management: false, sensitive: false },
  { id: 'world.trace.read', category: 'audit', management: false, sensitive: false },
  { id: 'world.conversations.read-metadata', category: 'conversations', management: false, sensitive: false },
  { id: 'world.conversations.read-content', category: 'conversations', management: false, sensitive: true },
] as const satisfies readonly WorldCharacterPermissionDescriptor[]

export const WORLD_CHARACTER_PERMISSION_DESCRIPTOR_MAP: Readonly<
  Record<WorldCharacterPermission, WorldCharacterPermissionDescriptor>
> = Object.fromEntries(
  WORLD_CHARACTER_PERMISSION_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
) as Record<WorldCharacterPermission, WorldCharacterPermissionDescriptor>

/** Permissions which require World Administrator status for long-term grant. */
export const WORLD_CHARACTER_MANAGEMENT_PERMISSIONS = [
  'world.settings.write',
  'world.characters.manage',
  'world.permissions.manage',
  'world.packages.manage',
  'world.integrations.manage',
  'world.model.assign',
] as const satisfies readonly WorldCharacterPermission[]

/**
 * The useful default when a member is promoted. It intentionally excludes
 * integration mutation, conversation content and any runtime danger mode.
 */
export const RECOMMENDED_ADMIN_PERMISSIONS = [
  'world.files.read',
  'world.files.write',
  'world.settings.read',
  'world.settings.write',
  'world.characters.read',
  'world.characters.manage',
  'world.permissions.read',
  'world.permissions.manage',
  'world.packages.read',
  'world.packages.manage',
  'world.integrations.read',
  'world.model.read',
  'world.model.assign',
  'world.approvals.read',
  'world.trace.read',
  'world.conversations.read-metadata',
] as const satisfies readonly WorldCharacterPermission[]

export type WorldAuthorityActorKind = 'owner' | 'employee'

export interface WorldAuthorityActor {
  kind: WorldAuthorityActorKind
  id: string
}

export interface WorldCharacterAuthority {
  worldId: string
  employeeId: string
  role: WorldCharacterRole
  permissionGrants: WorldCharacterPermission[]
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export interface WorldAuthorityChange {
  id: string
  worldId: string
  employeeId: string
  actorKind: WorldAuthorityActorKind
  actorId: string
  previousRole?: WorldCharacterRole
  nextRole: WorldCharacterRole
  addedPermissions: WorldCharacterPermission[]
  removedPermissions: WorldCharacterPermission[]
  reason: string
  createdAt: IsoTimestamp
}

export interface UpdateWorldCharacterAuthorityInput {
  worldId: string
  targetEmployeeId: string
  actor: WorldAuthorityActor
  role: WorldCharacterRole
  permissionGrants: WorldCharacterPermission[]
  reason: string
}

/** Alias kept for callers that use the longer API-oriented name. */
export type WorldCharacterAuthorityUpdateInput = UpdateWorldCharacterAuthorityInput

export interface WorldCharacterAuthorityUpdateRequest {
  role: WorldCharacterRole
  permissionGrants: WorldCharacterPermission[]
  reason: string
}

export interface WorldCharacterAuthoritiesResponse {
  worldId: string
  authorities: WorldCharacterAuthority[]
}

export type WorldPermissionRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired'
export type WorldPermissionDecisionScope = 'once' | 'persistent'

export interface WorldPermissionRequest {
  id: string
  workspaceId: string
  worldId: string
  employeeId: string
  workTurnId: string
  skillActionId: string
  permission: WorldCharacterPermission
  status: WorldPermissionRequestStatus
  decisionScope?: WorldPermissionDecisionScope
  decidedBy?: string
  decidedAt?: IsoTimestamp
  consumedAt?: IsoTimestamp
  createdAt: IsoTimestamp
  expiresAt: IsoTimestamp
}

export interface CreateWorldPermissionRequestInput {
  id?: string
  workspaceId: string
  worldId: string
  employeeId: string
  workTurnId: string
  skillActionId: string
  permission: WorldCharacterPermission
  createdAt?: IsoTimestamp
  expiresAt: IsoTimestamp
}

export interface DecideWorldPermissionRequestInput {
  decisionScope: WorldPermissionDecisionScope | 'reject'
  decidedBy: string
}

export interface WorldPermissionRequestsResponse {
  worldId: string
  requests: WorldPermissionRequest[]
}

export function isWorldCharacterPermission(value: string): value is WorldCharacterPermission {
  return (WORLD_CHARACTER_PERMISSIONS as readonly string[]).includes(value)
}

export function isWorldCharacterRole(value: string): value is WorldCharacterRole {
  return (WORLD_CHARACTER_ROLES as readonly string[]).includes(value)
}

export function permissionDescriptor(permission: WorldCharacterPermission): WorldCharacterPermissionDescriptor {
  return WORLD_CHARACTER_PERMISSION_DESCRIPTOR_MAP[permission]
}

export function isActiveEmployeeStatus(status: EmployeeStatus): boolean {
  return status !== 'archived'
}
