import { describe, expect, it, vi } from 'vitest'
import { parseSshOperation, resolveOs, sshCommandFor } from '../src/skills/ssh-command-parser.js'

describe('SSH command parser', () => {
  it('maps read-only intents to controlled operations', () => {
    expect(parseSshOperation('查看客厅主机的磁盘使用情况')).toMatchObject({ op: 'disk.usage' })
    expect(parseSshOperation('连 NAS 看看内存')).toMatchObject({ op: 'memory.usage', connectionId: 'NAS' })
    expect(parseSshOperation('查看系统信息')).toMatchObject({ op: 'system.info' })
    expect(parseSshOperation('列出正在运行的进程')).toMatchObject({ op: 'process.list' })
    expect(parseSshOperation('看看这台服务器上装了哪些软件')).toMatchObject({ op: 'package.list' })
  })

  it('maps write intents only with a validated safe name', () => {
    expect(parseSshOperation('重启 nginx 服务')).toMatchObject({ op: 'service.restart', params: { service: 'nginx' } })
    expect(parseSshOperation('安装 docker')).toMatchObject({ op: 'package.install', params: { package: 'docker' } })
    // Shell metacharacters cannot smuggle a second command.
    expect(parseSshOperation('安装 docker; rm -rf /')).toBeUndefined()
    expect(parseSshOperation('重启 nginx && reboot 服务')).toBeUndefined()
  })

  it('does not arm on an explicit refusal', () => {
    expect(parseSshOperation('不要重启服务器，继续用现有配置')).toBeUndefined()
  })

  it('resolves a named candidate device independent of a connector verb', () => {
    const candidates = [
      { displayName: '客厅主机', host: '10.0.0.10' },
      { displayName: '机房网关', host: '172.16.1.125' },
    ]
    expect(parseSshOperation('查下 10.0.0.10 的磁盘', { deviceCandidates: candidates })).toMatchObject({ op: 'disk.usage', connectionId: '客厅主机' })
    expect(parseSshOperation('看看那台机房网关的内存', { deviceCandidates: candidates })).toMatchObject({ op: 'memory.usage', connectionId: '机房网关' })
    // A prefix like 10.0.0.1 must not match host 10.0.0.10/10.0.0.11 style hosts.
    expect(parseSshOperation('查 10.0.0.11 磁盘', { deviceCandidates: candidates }).connectionId).toBeUndefined()
  })

  it('falls back to the single granted device when the user names none', () => {
    const candidates = [{ displayName: '客厅主机', host: '10.0.0.10' }]
    expect(parseSshOperation('看看磁盘', { deviceCandidates: candidates, singleDefaultDisplayName: '客厅主机' }))
      .toMatchObject({ op: 'disk.usage', connectionId: '客厅主机' })
  })

  it('builds real commands only for the detected OS, never free-form', () => {
    expect(sshCommandFor({ op: 'disk.usage', summary: '', params: {} }, 'linux')).toContain('df -h')
    expect(sshCommandFor({ op: 'service.restart', summary: '', params: { service: 'nginx' } }, 'linux')).toContain('systemctl restart nginx')
    expect(sshCommandFor({ op: 'package.install', summary: '', params: { package: 'docker' } }, 'macos')).toContain('brew install docker')
    expect(sshCommandFor({ op: 'package.install', summary: '', params: { package: 'x' } }, 'other')).toBeUndefined()
  })

  it('classifies probe output into an OS', () => {
    expect(resolveOs('Linux\nlinux-apt')).toBe('linux')
    expect(resolveOs('Darwin\nmacos-brew')).toBe('macos')
    expect(resolveOs('FreeBSD')).toBe('other')
  })
})
