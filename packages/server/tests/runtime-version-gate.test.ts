import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { AgentRuntimePort, AgentTurnRequest } from '@dsh-cyber/contracts'
import { SUPPORTED_HARNESS_VERSION, writeActiveHarnessRuntime } from '@dsh-cyber/harness-adapter'

import { createCyberServer, type CyberServer } from '../src/index.js'

const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class StubRuntime implements AgentRuntimePort {
  async runTurn(request: AgentTurnRequest) {
    return { agentSessionId: `stub-${request.agent.id}`, finalResponse: 'ok', eventCount: 0 }
  }

  async close() {}
}

/**
 * A candidate tree that looks exactly like a real activated runtime: one exact
 * version across the three contract packages, plus the `dsh` bin the adapter
 * launches. `version` is the only variable, so the boot gate is what the test
 * measures.
 */
async function candidateRoot(directory: string, version: string): Promise<string> {
  const root = join(directory, `candidate-${version}`)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), '{"private":true}\n', 'utf8')
  for (const packageName of [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-sdk-client',
    '@deepseek-ai/dsh-sdk-jsonrpc-server',
  ]) {
    const packageDirectory = join(root, 'node_modules', ...packageName.split('/'))
    await mkdir(packageDirectory, { recursive: true })
    await writeFile(
      join(packageDirectory, 'package.json'),
      `${JSON.stringify({ name: packageName, version })}\n`,
      'utf8',
    )
  }
  const binDirectory = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
  await mkdir(binDirectory, { recursive: true })
  await writeFile(join(binDirectory, 'bin.js'), '#!/usr/bin/env node\n', 'utf8')
  return root
}

async function activate(stateRoot: string, version: string): Promise<void> {
  const directory = join(stateRoot, 'candidates-fixture')
  await mkdir(directory, { recursive: true })
  await writeActiveHarnessRuntime(join(stateRoot, 'runtime'), {
    schemaVersion: 1,
    transactionId: `transaction-${version}`,
    candidateRoot: await candidateRoot(directory, version),
    version,
    activatedAt: new Date().toISOString(),
  })
}

async function boot(stateRoot: string): Promise<CyberServer> {
  const server = await createCyberServer({
    stateRoot,
    workspacePath: stateRoot,
    port: 0,
    runtime: new StubRuntime(),
  })
  servers.push(server)
  return server
}

async function freshStateRoot(): Promise<string> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-runtime-gate-'))
  roots.push(stateRoot)
  return stateRoot
}

describe('activated Harness runtime version gate', () => {
  it('refuses to boot on an older activated runtime and names the required version and the recovery command', async () => {
    const stateRoot = await freshStateRoot()
    // Still listed in the compatibility matrix, but older than the version this
    // build pins, so the current adapter can no longer drive it.
    await activate(stateRoot, '0.1.1-rc.1')

    const failure = await boot(stateRoot).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('0.1.1-rc.1')
    expect(message).toContain(SUPPORTED_HARNESS_VERSION)
    expect(message).toContain('runtime-rollback')
    expect(message).toContain(stateRoot)
  })

  it('gives the same upgrade instructions when the pointer claims the pinned version over an older tree', async () => {
    const stateRoot = await freshStateRoot()
    const directory = join(stateRoot, 'candidates-fixture')
    await mkdir(directory, { recursive: true })
    await writeActiveHarnessRuntime(join(stateRoot, 'runtime'), {
      schemaVersion: 1,
      transactionId: 'transaction-drifted',
      candidateRoot: await candidateRoot(directory, '0.1.0-rc.8'),
      version: SUPPORTED_HARNESS_VERSION,
      activatedAt: new Date().toISOString(),
    })

    const failure = await boot(stateRoot).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('0.1.0-rc.8')
    expect(message).toContain('runtime-rollback')
    expect(message).not.toContain('unavailable or incompatible')
  })

  it('boots on an activated runtime that matches the pinned version', async () => {
    const stateRoot = await freshStateRoot()
    await activate(stateRoot, SUPPORTED_HARNESS_VERSION)

    const server = await boot(stateRoot)
    const address = await server.start()
    expect(address.origin).toContain('http://127.0.0.1:')
  })
})
