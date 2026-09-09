import { describe, expect, it } from 'vitest'
import type { EnvironmentProfile } from '@dsh-cyber/contracts'

import {
  applyEnvironmentSignal,
  commandName,
  isCommandNotFound,
  presenceSignature,
  type EnvironmentSignal,
} from '../src/environments/environment-change-collector.js'

function profile(overrides: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
  return {
    schemaVersion: 1,
    profileId: 'local',
    os: 'windows',
    arch: 'x64',
    shell: 'powershell',
    tools: {
      ffmpeg: { present: false, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z' },
      docker: { present: true, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z', version: '27.0.0' },
      node: { present: true, source: 'builtin', lastCheckedAt: '2026-08-21T00:00:00.000Z', version: 'v20.11.1' },
    },
    notes: [],
    probedAt: '2026-08-21T00:00:00.000Z',
    fastSignature: presenceSignature({
      ffmpeg: { present: false, source: 'builtin', lastCheckedAt: '' },
      docker: { present: true, source: 'builtin', lastCheckedAt: '' },
      node: { present: true, source: 'builtin', lastCheckedAt: '' },
    }),
    fullDirty: false,
    ...overrides,
  }
}

function signal(overrides: Partial<EnvironmentSignal> = {}): EnvironmentSignal {
  return { toolName: 'pwsh', failed: false, ...overrides }
}

const clock = () => '2026-08-21T00:00:00.000Z'

describe('environment change collector', () => {
  it('promotes a tool the profile called absent when the host actually ran it', () => {
    const before = profile()
    const result = applyEnvironmentSignal(before, signal({ command: 'ffmpeg -i in.mp4 out.mp4' }), { clock })
    expect(result.changes).toEqual(['新增可用：ffmpeg'])
    expect(result.profile.tools.ffmpeg?.present).toBe(true)
    expect(result.profile.tools.ffmpeg?.version).toBeUndefined()
    expect(result.profile.fullDirty).toBe(true)
    expect(result.profile.fastSignature).not.toBe(before.fastSignature)
    // The input profile is never mutated.
    expect(before.tools.ffmpeg?.present).toBe(false)
  })

  it('demotes a tool the profile called present when the host could not find it', () => {
    const result = applyEnvironmentSignal(profile(), signal({
      command: 'docker ps',
      failed: true,
      exitCode: 1,
      output: "'docker' is not recognized as an internal or external command,\noperable program or batch file.",
    }), { clock })
    expect(result.changes).toEqual(['不再可用：docker'])
    expect(result.profile.tools.docker?.present).toBe(false)
    expect(result.profile.tools.docker?.version).toBeUndefined()
    expect(result.profile.notes.map((note) => note.text)).toEqual(['docker 在本机不可用：命令未找到'])
  })

  it('does not demote a tool because one of its own arguments was missing', () => {
    const result = applyEnvironmentSignal(profile(), signal({
      command: 'node missing.js',
      failed: true,
      output: "node:internal/modules/cjs/loader:1145\n  throw err;\nError: Cannot find module '/tmp/missing.js'",
    }), { clock })
    expect(result.changes).toEqual([])
    expect(result.profile.tools.node?.present).toBe(true)
  })

  it('does not demote on a file-level ENOENT that merely mentions the tool name', () => {
    // `python missing.py` reports a missing file, not a missing interpreter.
    expect(isCommandNotFound('python', "python: can't open file '/tmp/missing.py': [Errno 2] No such file or directory")).toBe(false)
    // `sh: 1: ffmpeg: not found` is a missing interpreter.
    expect(isCommandNotFound('ffmpeg', 'sh: 1: ffmpeg: not found')).toBe(true)
    expect(isCommandNotFound('docker', "'docker' is not recognized as an internal or external command")).toBe(true)
  })

  it('records a concrete host restriction as a bounded host-owned note', () => {
    const result = applyEnvironmentSignal(profile(), signal({
      command: 'node build.js',
      failed: true,
      output: 'Error: EPERM: operation not permitted, open \'C:\\Windows\\System32\\drivers\\etc\\hosts\'',
    }), { clock })
    expect(result.changes).toEqual(['受限制：node（权限被拒绝（EPERM））'])
    expect(result.profile.notes.map((note) => note.text)).toEqual(['node 受限制：权限被拒绝（EPERM）'])
    expect(result.profile.tools.node?.present).toBe(true)
  })

  it('learns nothing from a failure the host cannot classify', () => {
    const result = applyEnvironmentSignal(profile(), signal({
      command: 'node test.js',
      failed: true,
      output: '3 tests failed\nExpected 1 to be 2',
    }), { clock })
    expect(result.changes).toEqual([])
    expect(result.profile).toEqual(profile())
  })

  it('ignores model prose and non-shell tools entirely', () => {
    // A read tool cannot teach presence, however its output reads.
    expect(applyEnvironmentSignal(profile(), { toolName: 'read', failed: false, command: 'ffmpeg' }, { clock }).changes).toEqual([])
    // A shell success on a tool the profile already calls present is not news.
    expect(applyEnvironmentSignal(profile(), signal({ command: 'node -v' }), { clock }).changes).toEqual([])
    // A shell failure whose output is only the model's own wording teaches nothing.
    expect(applyEnvironmentSignal(profile(), signal({
      failed: true,
      command: 'docker ps',
      output: '模型认为 docker 没有安装，建议改用 podman。',
    }), { clock }).changes).toEqual([])
  })

  it('is idempotent: the same lesson is never recorded twice', () => {
    const first = applyEnvironmentSignal(profile(), signal({
      command: 'docker ps',
      failed: true,
      output: 'docker: command not found',
    }), { clock })
    const second = applyEnvironmentSignal(first.profile, signal({
      command: 'docker ps',
      failed: true,
      output: 'docker: command not found',
    }), { clock })
    expect(second.changes).toEqual([])
    expect(second.profile.notes).toHaveLength(1)
  })

  it('reads a command name conservatively from real command lines', () => {
    expect(commandName('ffmpeg -i a.mp4')).toBe('ffmpeg')
    expect(commandName('  "C:\\Program Files\\Git\\cmd\\git.exe" status')).toBe('git')
    expect(commandName('& ./bin/pnpm.cmd run build')).toBe('pnpm')
    expect(commandName('/usr/local/bin/ffmpeg -version')).toBe('ffmpeg')
    expect(commandName('cd /tmp && ffmpeg -i a.mp4')).toBe('cd')
    expect(commandName('')).toBeUndefined()
    expect(commandName(undefined)).toBeUndefined()
  })
})
