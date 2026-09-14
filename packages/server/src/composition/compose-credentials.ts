import type { SqliteStore } from '@dsh-cyber/persistence'

import type { IntegrationService } from '../integrations/integration-service.js'
import { CredentialManager } from '../services/credential-manager.js'
import type { ModelCredentialService } from '../services/model-credential-service.js'
import { TraceSanitizer } from '../world-trace/trace-sanitizer.js'

/** Shared credential facade and sanitizer used by every server boundary. */
export function composeCredentialBoundary(input: {
  store: SqliteStore
  credentials: ModelCredentialService
  integrations: IntegrationService
}): { manager: CredentialManager; sanitizer: TraceSanitizer } {
  const manager = new CredentialManager({
    modelCredentials: input.credentials,
    integrations: input.integrations,
    listModelReferences: () => input.store.listWorkspaces().flatMap((workspace) => CredentialManager.referencesFromProfiles(
      input.store.listModelProfiles(workspace.id),
      input.store.listModelProviders(workspace.id),
    )),
  })
  return {
    manager,
    sanitizer: new TraceSanitizer({
      redactText: (value, workspaceId) => manager.redactText(value, workspaceId),
      scopeForEntry: (worldId) => input.store.getWorld(worldId)?.workspaceId,
    }),
  }
}
