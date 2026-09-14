import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { credentialVariable, credentialVariableForEnvironment } from '@dsh-cyber/contracts'

import { createBuiltinIntegrationRegistry } from '../src/integrations/builtin-integration-registry.js'
import { MCP_INTEGRATION_ID } from '../src/integrations/mcp-provider.js'
import { IntegrationService } from '../src/integrations/integration-service.js'
import { CredentialManager } from '../src/services/credential-manager.js'
import { ModelCredentialService } from '../src/services/model-credential-service.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('CredentialManager', () => {
  it('unifies model and integration values behind variables and resolves one connection at execution time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-credential-manager-'))
    roots.push(root)
    const modelCredentials = await ModelCredentialService.open(root)
    const integrations = await IntegrationService.open(root, createBuiltinIntegrationRegistry())
    const workspaceId = 'workspace-1'
    const connection = await integrations.save({
      workspaceId,
      integrationId: MCP_INTEGRATION_ID,
      config: { service: 'github', mode: 'remote', endpoint: 'http://127.0.0.1:3900/mcp' },
      enabled: true,
      credential: 'mcp-bearer-secret-123456',
    })
    await integrations.save({
      workspaceId: 'workspace-2',
      integrationId: MCP_INTEGRATION_ID,
      config: { service: 'linear', mode: 'remote', endpoint: 'http://127.0.0.1:3901/mcp' },
      enabled: true,
      credential: 'other-workspace-secret-123456',
    })
    const profileId = 'model-profile-1'
    const envName = await modelCredentials.set(profileId, 'model-api-secret-123456')
    const externalEnv = { EXTERNAL_API_KEY: 'external-api-secret-123456' }
    const manager = new CredentialManager({
      modelCredentials,
      integrations,
      environment: externalEnv,
      listModelReferences: () => [
        { id: profileId, envName },
        { id: 'external-profile', envName: 'EXTERNAL_API_KEY' },
      ],
    })

    const modelVariable = credentialVariableForEnvironment(envName).variable
    const integrationVariable = credentialVariable(`integration:${connection.id}:bearerToken`)
    const safe = manager.redactText('model-api-secret-123456 mcp-bearer-secret-123456 external-api-secret-123456')
    expect(safe).toContain(modelVariable)
    expect(safe).toContain(integrationVariable)
    expect(safe).not.toContain('model-api-secret-123456')
    expect(safe).not.toContain('mcp-bearer-secret-123456')
    expect(safe).not.toContain('external-api-secret-123456')

    const resolved = manager.resolveConnectionJson(workspaceId, connection.id, {
      headers: { Authorization: integrationVariable },
      body: { token: integrationVariable },
    })
    expect(resolved).toEqual({
      headers: { Authorization: 'mcp-bearer-secret-123456' },
      body: { token: 'mcp-bearer-secret-123456' },
    })

    const event = manager.redactRuntimeEvent({
      kind: 'tool.completed',
      source: 'test',
      sourceSessionId: 'session',
      content: '返回 mcp-bearer-secret-123456',
      metadata: { toolOutput: 'mcp-bearer-secret-123456', authorization: 'mcp-bearer-secret-123456' },
    })
    expect(JSON.stringify(event)).not.toContain('mcp-bearer-secret-123456')
    expect(event.metadata.toolOutput).toContain(integrationVariable)
    expect(JSON.stringify(manager.variables())).not.toContain('mcp-bearer-secret-123456')
    const scoped = manager.redactText('mcp-bearer-secret-123456 other-workspace-secret-123456', workspaceId)
    expect(scoped).toContain(integrationVariable)
    expect(scoped).toContain('${credential.external}')
    expect(scoped).not.toContain('mcp-bearer-secret-123456')
    expect(scoped).not.toContain('other-workspace-secret-123456')

    integrations.close()
    modelCredentials.close()
  })
})
