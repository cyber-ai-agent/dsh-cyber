import { Server } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'

import { SshSessionPool } from '../src/integrations/ssh-client.js'

const USER = 'tester'
const PASSWORD = 'verify-password'
const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function startSshServer(): Promise<{ port: number; stats: { connections: number; execs: number } }> {
  const { utils } = await import('ssh2')
  const keys = utils.generateKeyPairSync('rsa', { bits: 1024 })
  const stats = { connections: 0, execs: 0 }
  const server = new Server({ hostKeys: [keys.private] }, (client) => {
    stats.connections += 1
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASSWORD) ctx.accept()
      else ctx.reject()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _rejectExec, info) => {
          stats.execs += 1
          const stream = acceptExec()
          stream.write(`conn#${stats.connections}:${info.command}\n`)
          stream.exit(0)
          stream.end()
        })
      })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  return { port: (server.address() as { port: number }).port, stats }
}

describe('SshSessionPool over a real ssh2 server', () => {
  it('keeps one authenticated transport across sequential commands and reconnects after an idle edit', async () => {
    const { port, stats } = await startSshServer()
    const device = { host: '127.0.0.1', port, username: USER, password: PASSWORD }
    const pool = new SshSessionPool({ idleMs: 5_000 })

    const r1 = await pool.exec(device, 'uptime')
    const r2 = await pool.exec(device, 'df -h')
    const r3 = await pool.exec(device, 'free')
    expect([r1.stdout.trim(), r2.stdout.trim(), r3.stdout.trim()]).toEqual([
      'conn#1:uptime',
      'conn#1:df -h',
      'conn#1:free',
    ])
    // All three commands reused the very same authenticated transport.
    expect(stats.connections).toBe(1)
    expect(stats.execs).toBe(3)

    // A credential edit changes the fingerprint -> a fresh session is opened.
    await pool.exec({ ...device, password: 'other' }).catch(() => undefined)
    const after = await pool.exec(device, 'id')
    expect(after.stdout.trim()).toBe('conn#2:id')
    expect(stats.connections).toBe(2)

    await pool.close()
  })

  it('does not call exec before the transport is ready when two first commands race', async () => {
    const { port, stats } = await startSshServer()
    const device = { host: '127.0.0.1', port, username: USER, password: PASSWORD }
    const pool = new SshSessionPool({ idleMs: 5_000 })

    // Two concurrent first commands on the same fresh key: the second must
    // wait for the first connect attempt (ready) instead of calling
    // ssh2 Client.exec on a not-yet-connected transport.
    const results = await Promise.all([
      pool.exec(device, 'one'),
      pool.exec(device, 'two'),
      pool.exec(device, 'three'),
    ])
    expect(results.map((result) => result.stdout.trim())).toEqual([
      'conn#1:one',
      'conn#1:two',
      'conn#1:three',
    ])
    // One connection total, three serialized execs on it.
    expect(stats.connections).toBe(1)
    expect(stats.execs).toBe(3)

    await pool.close()
  })
})
