/**
 * SSH intent -> controlled operation parsing.
 *
 * The model never invents a shell command. The parser maps an utterance to a
 * whitelisted abstract operation (check disk / memory / system info, restart a
 * named service, list packages, install a named package). Parameters are
 * validated against a strict charset so nothing that could smuggle a second
 * command survives. Real shell is produced later by the executor based on the
 * target's detected OS — the character only ever says *what*, never the raw
 * command line.
 */

export interface SshOperation {
  /** Abstract operation id, executor resolves it into a real command per OS. */
  op: 'system.info' | 'disk.usage' | 'memory.usage' | 'process.list' | 'service.restart' | 'package.list' | 'package.install' | 'file.list'
  /** Device connection id resolved by the adapter (not set by parser). */
  connectionId?: string
  /** Free-form intent line for the approval card and trace. */
  summary: string
  /** Structured params; every value is charset-validated. */
  params: Record<string, string>
}

export interface SshDeviceHint {
  /** Candidate device references the utterance may name (displayName/host). */
  deviceCandidates?: ReadonlyArray<{ displayName: string; host?: string }>
  /** Display name used when the role only has one usable device. */
  singleDefaultDisplayName?: string
}

const UNSAFE = /[;|&$`\\\n\r"'()[\]{}]/
const SAFE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._:+/=-]{0,127}$/u

function plain(value: string): string {
  return value.trim()
}

/** A service/package/file name may contain only safe characters, no shell metachars. */
function safeName(value: string): string | undefined {
  const candidate = plain(value)
  return SAFE_NAME.test(candidate) && !UNSAFE.test(candidate) ? candidate : undefined
}

const SYSTEM_INFO = /(查看|查|看看|检查|查询|读|了解|看下)?\s*(系统信息|系统版本|内核|操作系统|os)\s*(信息|版本|是什么|怎么样)?/
const DISK = /(磁盘|硬盘|存储|空间|df|挂载|分区)\s*(使用|占用|满了|空间|大小|情况|多少)?|(查看|查|看看|检查)\s*磁盘/
const MEMORY = /(内存|mem|free)\s*(使用|占用|剩余|情况|多少)?|(查看|查|看看|检查)\s*(内存|mem)/
const PROCESS = /(进程|process)\s*(列表|查看|看看|正在运行|有哪些)?|(查看|查|看看)\s*进程/
const SERVICE_RESTART = /重启|重新启动|restart/
const PACKAGE_LIST = /(已安装的|装了哪些|安装的)?\s*(软件|包|程序|package|软件包)\s*(列表|有哪些|装了哪些|看看|查看|查)|(装了|安装过|装过)\s*(哪些|什么)\s*(软件|包|程序|软件包)/i
const PACKAGE_INSTALL = /(安装|装|装一个|install)\s+(?:软件|包|程序|软件包)?\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9._+:-]*)/iu
// A directory listing needs an explicit leading slash or the word 目录/文件夹;
// bare "查看" must not swallow disk/memory intents.
const FILE_LIST = /(?:列出|查看|看看|ls|浏览)\s*(?:目录|文件夹|路径)\s*([\p{L}\p{N}._/:+-]*)|(?:^|\s)\/[\p{L}\p{N}._/:+-]+/u

const DEVICE_REFERENCE = /(?:连|到|通过|ssh|用)\s*(?:SSH\s*)?(?:连接\s*)?([\p{L}\p{N}][\p{L}\p{N}._-]{0,31})(?:主机|服务器|设备|机器|盒子|nas|NAS)?/u

const NEGATION = /(?:不要|别|不用|无需|避免|勿)[^。！？!?]{0,8}(?:重启|安装|执行|操作|运行|查|看|列)/

/**
 * Resolve which device an utterance means.
 *
 * Device and operation are independent: the user may name the device with a
 * connector (“连客厅主机…”) or without one (“查下那台客厅主机的磁盘”), may use
 * the host address, or may refer back to a device with 这台/那台/服务器. When
 * the caller supplies `singleDefaultDisplayName` (the role only has one usable
 * device), an utterance that performs an operation but names no device
 * resolves to that default instead of dangling.
 */
function resolveDeviceName(prompt: string, hints: SshDeviceHint): string | undefined {
  const candidates = hints.deviceCandidates ?? []
  if (candidates.length > 0) {
    // Longest name first so “客厅主机” beats the substring “客厅”.
    const sorted = [...candidates].sort((left, right) => right.displayName.length - left.displayName.length)
    for (const candidate of sorted) {
      if (candidate.displayName.length > 0 && prompt.includes(candidate.displayName)) return candidate.displayName
    }
    for (const candidate of sorted) {
      const host = candidate.host ?? ''
      if (host.length < 4) continue
      const at = prompt.indexOf(host)
      if (at < 0) continue
      // Refuse a prefix match like 10.0.0.1 inside 10.0.0.11 by checking the
      // next char is not another host/name character.
      const next = prompt[at + host.length]
      const boundary = next === undefined || !/[0-9A-Za-z._:.-]/.test(next)
      if (boundary) return candidate.displayName
    }
  }
  const connector = extractDeviceName(prompt)
  if (connector !== undefined) return connector
  // Only one usable device → a bare operation unambiguously targets it.
  // With several devices we refuse to guess which one the user meant.
  if (hints.singleDefaultDisplayName !== undefined) return hints.singleDefaultDisplayName
  return undefined
}

/**
 * Parse one user utterance into at most one controlled SSH operation.
 * Returns undefined when no whitelisted intent is found or the request is
 * explicitly negated.
 */
export function parseSshOperation(prompt: string, hints: SshDeviceHint = {}): SshOperation | undefined {
  if (NEGATION.test(prompt)) return undefined
  const deviceName = resolveDeviceName(prompt, hints)

  // Order matters: install/service checks come before generic info verbs so
  // "重启 xx 服务" does not fall into SYSTEM_INFO.
  const installMatch = PACKAGE_INSTALL.exec(prompt)
  if (installMatch !== null) {
    const name = safeName(installMatch[2] ?? '')
    // Reject when anything shell-ish trails the package name: "docker; rm"
    // or "docker && reboot" must never pass as package 'docker'.
    const trailing = prompt.slice(installMatch.index + installMatch[0].length)
    if (name === undefined || UNSAFE.test(trailing)) return undefined
    return { op: 'package.install', summary: `安装软件包 ${name}`, params: { package: name }, ...(deviceName === undefined ? {} : { connectionId: deviceName }) }
  }
  if (SERVICE_RESTART.test(prompt)) {
    const service = /重启(?:服务|程序|进程|任务)?\s*[:：]?\s*([\p{L}\p{N}._+/-]+)/iu.exec(prompt)?.[1]
    const name = service === undefined ? undefined : safeName(service)
    if (name === undefined) return undefined
    // A service restart with a trailing shell continuation is refused.
    const restartMatch = /重启(?:服务|程序|进程|任务)?\s*[:：]?\s*([\p{L}\p{N}._+/-]+)/iu.exec(prompt)
    if (restartMatch !== null) {
      const trailing = prompt.slice(restartMatch.index + restartMatch[0].length)
      if (UNSAFE.test(trailing)) return undefined
    }
    return { op: 'service.restart', summary: `重启服务 ${name}`, params: { service: name }, ...(deviceName === undefined ? {} : { connectionId: deviceName }) }
  }
  if (PACKAGE_LIST.test(prompt)) {
    return { op: 'package.list', summary: '列出已安装软件包', params: {}, ...(deviceName === undefined ? {} : { connectionId: deviceName }) }
  }
  if (FILE_LIST.test(prompt)) {
    const listed = /(?:列出|查看|看看|ls|浏览)\s*(?:目录|文件夹|路径)\s*[:：]?\s*(\/[\p{L}\p{N}._/:+-]*)?/u.exec(prompt)
    const bare = /(?:^|\s)\/([\p{L}\p{N}._/:+-]+)/u.exec(prompt)
    const raw = listed?.[1] ?? bare?.[1]
    const path = raw === undefined ? undefined : plain(raw)
    if (path !== undefined && (path.includes('..') || UNSAFE.test(path))) return undefined
    return { op: 'file.list', summary: `列出目录 ${path ?? '/'} 下的文件`, params: path === undefined ? {} : { path }, ...(deviceName === undefined ? {} : { connectionId: deviceName }) }
  }
  if (PROCESS.test(prompt)) {
    return { op: 'process.list', summary: '列出正在运行的进程', params: {}, ...(deviceName === undefined ? {} : { connectionId: deviceName }) }
  }
  if (DISK.test(prompt)) {
    return { op: 'disk.usage', summary: '查看磁盘使用情况', params: {}, ...(deviceName === undefined ? {} : { connectionId: deviceName }) }
  }
  if (MEMORY.test(prompt)) {
    return { op: 'memory.usage', summary: '查看内存使用情况', params: {}, ...(deviceName === undefined ? {} : { connectionId: deviceName }) }
  }
  if (SYSTEM_INFO.test(prompt)) {
    return { op: 'system.info', summary: '查看系统信息', params: {}, ...(deviceName === undefined ? {} : { connectionId: deviceName }) }
  }
  return undefined
}

function extractDeviceName(prompt: string): string | undefined {
  const match = DEVICE_REFERENCE.exec(prompt)
  return match === null ? undefined : plain(match[1] ?? '')
}

/**
 * Turn an abstract operation + a detected target OS into a real, non-interactive
 * shell command. Only built by the host; the model never supplies this string.
 */
export function sshCommandFor(op: SshOperation, os: 'linux' | 'macos' | 'other'): string | undefined {
  const pkgs = os === 'macos' ? 'brew list' : 'dpkg -l'
  const pkgInstall = (name: string): string | undefined => {
    if (os === 'linux') return `apt-get install -y --no-install-recommends ${name}`
    if (os === 'macos') return `brew install ${name}`
    return undefined
  }
  switch (op.op) {
    case 'system.info': return 'uname -a && (cat /etc/os-release 2>/dev/null | head -n 6 || sw_vers 2>/dev/null)'
    case 'disk.usage': return 'df -h'
    case 'memory.usage': return 'free -h 2>/dev/null || vm_stat'
    case 'process.list': return 'ps aux --sort=-%cpu | head -n 25 2>/dev/null || ps aux | head -n 25'
    case 'file.list': return `ls -lah ${op.params.path ?? '.'}`
    case 'package.list': return pkgs
    case 'package.install': return pkgInstall(op.params.package ?? '')
    case 'service.restart': {
      if (os === 'linux') return `systemctl restart ${op.params.service ?? ''}`
      if (os === 'macos') return `launchctl kickstart -k system/$(launchctl list | awk '/${escapeLoose(op.params.service ?? '')}/{print $3}')`
      return undefined
    }
  }
}

/** Loose escaping only for the launchctl awk pattern — conservative and bounded. */
function escapeLoose(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '')
}

/** Cheap remote OS probe; only runs where the target already accepted our key. */
export function osProbeCommand(): string {
  return 'uname -s && (command -v apt-get >/dev/null && echo linux-apt; command -v apk >/dev/null && echo linux-apk; command -v brew >/dev/null && echo macos-brew)'
}

export function resolveOs(probe: string): 'linux' | 'macos' | 'other' {
  if (probe.includes('Darwin') || probe.includes('macos-brew')) return 'macos'
  if (probe.includes('Linux') || probe.includes('linux-')) return 'linux'
  return 'other'
}
