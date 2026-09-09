import type { SqliteStore } from '@dsh-cyber/persistence'

import type { EnvironmentDeviceSource, EnvironmentDeviceTarget } from '../environments/environment-remote.js'
import { sshExecOnce } from '../integrations/ssh-client.js'
import type { IntegrationService } from '../integrations/integration-service.js'
import { SSH_DEVICE_INTEGRATION_ID } from '../integrations/ssh-provider.js'
import { createConnectionGrantsResolver } from '../skills/ssh-skill-adapter.js'

/** A prompt is not a device inventory; four granted devices is already a lot. */
const MAX_DEVICE_TARGETS = 4

/**
 * The devices a character may actually reach, resolved from durable rows only.
 *
 * A device appears here only when the character's current revision grants that
 * exact connection, the connection is enabled, and a usable credential exists
 * - the same three conditions the SSH skill adapter enforces at execution
 * time. Credentials are resolved from the vault per call and never leave this
 * closure.
 */
export function composeSshEnvironmentDeviceSource(input: {
  store: SqliteStore
  integrations: IntegrationService
}): EnvironmentDeviceSource {
  const grantsFor = createConnectionGrantsResolver(input.store)
  return {
    async targets({ worldId, characterId }) {
      const world = input.store.getWorld(worldId)
      if (world === undefined) return []
      const granted = new Set(grantsFor(characterId) ?? [])
      if (granted.size === 0) return []
      const targets: EnvironmentDeviceTarget[] = []
      for (const connection of input.integrations.listByType(world.workspaceId, SSH_DEVICE_INTEGRATION_ID)) {
        if (targets.length >= MAX_DEVICE_TARGETS) break
        if (!connection.enabled || !granted.has(connection.id)) continue
        const target = sshEnvironmentDeviceTarget({
          integrations: input.integrations,
          workspaceId: world.workspaceId,
          connectionId: connection.id,
        })
        if (target !== undefined) targets.push(target)
      }
      return targets
    },
  }
}

/**
 * One SSH probe target for an exact connection, or undefined when the device
 * is not usable (disabled, unknown, or without a credential). The owner-facing
 * refresh route and the per-turn device source share this so both enforce the
 * same conditions.
 */
export function sshEnvironmentDeviceTarget(input: {
  integrations: IntegrationService
  workspaceId: string
  connectionId: string
}): EnvironmentDeviceTarget | undefined {
  const connection = input.integrations.getById(input.workspaceId, input.connectionId)
  if (connection === undefined || !connection.enabled) return undefined
  const secrets = input.integrations.secretsForConnection(input.workspaceId, input.connectionId)
  if (secrets === undefined || (secrets.privateKey === undefined && secrets.password === undefined)) return undefined
  const config = connection.config
  const device = {
    host: String(config.host ?? connection.id),
    port: Number(config.port ?? 22),
    username: String(config.username ?? 'root'),
    ...(secrets.privateKey === undefined ? {} : { privateKey: secrets.privateKey }),
    ...(secrets.privateKey !== undefined || secrets.password === undefined ? {} : { password: secrets.password }),
  }
  return {
    profileId: `ssh:${connection.id}`,
    displayName: connection.displayName,
    host: device.host,
    exec: (command) => sshExecOnce(device, command),
  }
}
