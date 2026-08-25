import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SqliteStore } from '@dsh-cyber/persistence'

import { WorldCharacterAuthorityService } from '../../src/services/world-character-authority-service.js'
import { WorldPackageInstanceService } from '../../src/services/world-package-instance-service.js'
import { WorldRootService } from '../../src/services/world-root-service.js'
import { WorldSettingsService } from '../../src/services/world-settings-service.js'
import { createWorldManagementHost } from '../../src/skills/world-management-host.js'
import type { WorldManagementHost } from '../../src/skills/world-management-adapter.js'

/**
 * Builds the production world-management host.
 *
 * Tests must never hand the adapter a bespoke host: a capability that exists
 * only in a fixture is not a shipped capability, and that is exactly how two
 * descriptors came to be published without a handler.
 */
export function createWorldManagementHostForTest(store?: SqliteStore, stateRoot?: string): WorldManagementHost {
  const root = stateRoot ?? mkdtempSync(join(tmpdir(), 'dsh-host-fixture-'))
  const roots = new WorldRootService(root)
  const target = store ?? ({} as SqliteStore)
  return createWorldManagementHost({
    store: target,
    worldSettings: new WorldSettingsService(roots),
    worldPackages: new WorldPackageInstanceService(target, roots),
    authority: new WorldCharacterAuthorityService(target),
  })
}
