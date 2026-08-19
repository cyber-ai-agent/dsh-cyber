import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { runCli, type CliIo } from '../src/index.js'

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  }
}

describe('dsh-cyber CLI', () => {
  it('starts the standalone loopback service with one command and keeps data for doctor', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-cli-'))
    const captured = captureIo()
    const openBrowser = vi.fn(async () => {})
    let health: unknown

    const exitCode = await runCli(
      ['web', '--port', '0', '--data-dir', stateRoot, '--workspace', stateRoot, '--no-open'],
      {
        cwd: stateRoot,
        io: captured.io,
        openBrowser,
        waitForShutdown: async (server) => {
          const address = server.address()
          expect(address).toBeDefined()
          health = await fetch(`${address!.origin}/api/health`).then((response) => response.json())
          await server.close()
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(openBrowser).not.toHaveBeenCalled()
    expect(health).toMatchObject({ ok: true })
    expect(captured.stderr).toEqual([])
    expect((await stat(join(stateRoot, 'data', 'dsh-cyber.sqlite'))).size).toBeGreaterThan(0)

    const doctor = captureIo()
    expect(await runCli(['doctor', '--data-dir', stateRoot], { io: doctor.io })).toBe(0)
    expect(JSON.parse(doctor.stdout[0]!)).toMatchObject({
      ok: true,
      database: { ok: true, readOnly: true },
    })
  })

  it('creates verified backup and portable export artifacts', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-cyber-cli-'))
    const web = captureIo()
    expect(
      await runCli(['web', '--port', '0', '--data-dir', stateRoot, '--no-open'], {
        cwd: stateRoot,
        io: web.io,
        waitForShutdown: async (server) => server.close(),
      }),
    ).toBe(0)

    const backupPath = join(stateRoot, 'manual-backup.sqlite')
    const exportPath = join(stateRoot, 'manual-export.json')
    const backup = captureIo()
    const portable = captureIo()
    expect(
      await runCli(['backup', '--data-dir', stateRoot, '--output', backupPath], { io: backup.io }),
    ).toBe(0)
    expect(
      await runCli(['export', '--data-dir', stateRoot, '--output', exportPath], { io: portable.io }),
    ).toBe(0)
    expect((await stat(backupPath)).size).toBeGreaterThan(0)
    const exported = JSON.parse(await readFile(exportPath, 'utf8')) as { format: string }
    expect(exported.format).toBe('dsh-cyber-export')
    expect(backup.stdout).toEqual([backupPath])
    expect(portable.stdout).toEqual([exportPath])
  })

  it('prints self-contained help and rejects unknown commands without throwing', async () => {
    const help = captureIo()
    expect(await runCli(['help'], { io: help.io })).toBe(0)
    expect(help.stdout.join('\n')).toContain('dsh-cyber web')

    const unknown = captureIo()
    expect(await runCli(['unknown'], { io: unknown.io })).toBe(1)
    expect(unknown.stderr[0]).toContain('Unknown command')
  })
})
