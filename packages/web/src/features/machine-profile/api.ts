import type { EnvironmentProfile } from '@dsh-cyber/contracts'

import { api } from '../../api.js'

const enc = encodeURIComponent

/**
 * The machine profile is host state: one local profile per machine, and one
 * profile per connected device. A null profile is not an error - it simply
 * means the host has not probed this machine yet.
 */
export async function loadLocalProfile(signal?: AbortSignal): Promise<EnvironmentProfile | undefined> {
  const result = await api<{ profile: EnvironmentProfile | null }>(
    '/api/environments/local',
    signal === undefined ? undefined : { signal },
  )
  return result.profile ?? undefined
}

/** An owner-triggered refresh runs the full version battery by default. */
export async function refreshLocalProfile(tier: 'fast' | 'full' = 'full'): Promise<EnvironmentProfile> {
  const result = await api<{ profile: EnvironmentProfile }>('/api/environments/local/refresh', {
    method: 'POST',
    body: JSON.stringify({ tier }),
  })
  return result.profile
}

export async function addCustomTool(name: string): Promise<EnvironmentProfile> {
  const result = await api<{ profile: EnvironmentProfile }>('/api/environments/local/tools', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  return result.profile
}

export async function removeCustomTool(name: string): Promise<EnvironmentProfile> {
  const result = await api<{ profile: EnvironmentProfile }>(`/api/environments/local/tools/${enc(name)}`, {
    method: 'DELETE',
  })
  return result.profile
}

/** One connected device, addressed by the same connection id the grants use. */
export interface DeviceEnvironmentScope {
  workspaceId: string
  integrationId: string
  connectionId: string
}

function devicePath(scope: DeviceEnvironmentScope): string {
  return `/api/workspaces/${enc(scope.workspaceId)}/integrations/${enc(scope.integrationId)}/connections/${enc(scope.connectionId)}/environment`
}

export async function loadDeviceProfile(
  scope: DeviceEnvironmentScope,
  signal?: AbortSignal,
): Promise<EnvironmentProfile | undefined> {
  const result = await api<{ profile: EnvironmentProfile | null }>(
    devicePath(scope),
    signal === undefined ? undefined : { signal },
  )
  return result.profile ?? undefined
}

/** Probing a device costs a real SSH round trip, so this only runs on request. */
export async function refreshDeviceProfile(
  scope: DeviceEnvironmentScope,
  tier: 'fast' | 'full' = 'full',
): Promise<EnvironmentProfile> {
  const result = await api<{ profile: EnvironmentProfile }>(`${devicePath(scope)}/refresh`, {
    method: 'POST',
    body: JSON.stringify({ tier }),
  })
  return result.profile
}
