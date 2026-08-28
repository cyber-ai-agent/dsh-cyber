import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import type { ModelProviderKind } from '@dsh-cyber/contracts'

export interface ModelHostnameResolver {
  resolve(hostname: string): Promise<readonly string[]>
}

export const systemModelHostnameResolver: ModelHostnameResolver = {
  async resolve(hostname) {
    const records = await lookup(hostname, { all: true, verbatim: true })
    return records.map((record) => record.address)
  },
}

export interface ModelUrlPolicyOptions {
  resolver?: ModelHostnameResolver
  /** Defaults to true. Tests may disable this only with an explicit reason. */
  resolvePublicHosts?: boolean
}

export type ModelUrlPolicyCode =
  | 'model_base_url_invalid'
  | 'model_base_url_credentials'
  | 'model_base_url_insecure'
  | 'model_base_url_private_target'
  | 'model_base_url_dns_failed'

export class ModelUrlPolicyError extends Error {
  readonly code: ModelUrlPolicyCode

  constructor(code: ModelUrlPolicyCode, message: string) {
    super(message)
    this.name = 'ModelUrlPolicyError'
    this.code = code
  }
}

/**
 * Applies the same syntactic and host policy used by model profile saving.
 * Remote DNS resolution is intentionally kept out of this synchronous save
 * check; discovery calls assertModelDiscoveryUrl before it opens a socket.
 */
export function assertModelBaseUrl(value: string, providerKind: ModelProviderKind): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new ModelUrlPolicyError('model_base_url_invalid', '模型接口地址格式不正确。')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new ModelUrlPolicyError('model_base_url_invalid', '模型接口只支持 HTTP 或 HTTPS 地址。')
  }
  if (url.username || url.password) {
    throw new ModelUrlPolicyError('model_base_url_credentials', '模型接口地址不能包含用户名或密码。')
  }

  const hostname = normalizeHostname(url.hostname)
  if (providerKind === 'openai-compatible-local') {
    if (!['http:', 'https:'].includes(url.protocol) || !isExplicitPrivateHostname(hostname)) {
      throw new ModelUrlPolicyError('model_base_url_invalid', '本机或局域网模型必须使用明确的回环地址或私有网络地址。')
    }
    return url
  }

  if (url.protocol !== 'https:') {
    throw new ModelUrlPolicyError('model_base_url_insecure', '公网模型服务必须使用 HTTPS 地址。')
  }
  if (isBlockedHostname(hostname)) {
    throw new ModelUrlPolicyError('model_base_url_private_target', '公网模型服务不能指向本机、私有网络、链路本地或保留地址。')
  }
  return url
}

/**
 * Validates a discovery target and, for public hostnames, checks every DNS
 * answer before credentials are handed to fetch. A resolver is injectable so
 * tests can exercise DNS rebinding and metadata-address cases deterministically.
 */
export async function assertModelDiscoveryUrl(
  value: string,
  providerKind: ModelProviderKind,
  options: ModelUrlPolicyOptions = {},
): Promise<URL> {
  const url = assertModelBaseUrl(value, providerKind)
  if (providerKind === 'openai-compatible-local') return url

  const hostname = normalizeHostname(url.hostname)
  if (isIP(hostname) !== 0) return url
  if (options.resolvePublicHosts === false) return url

  const resolver = options.resolver ?? systemModelHostnameResolver
  let addresses: readonly string[]
  try {
    addresses = await resolver.resolve(hostname)
  } catch {
    throw new ModelUrlPolicyError('model_base_url_dns_failed', '无法解析公网模型服务地址，请检查域名和网络。')
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new ModelUrlPolicyError('model_base_url_private_target', '公网模型服务的域名解析到了本机、私有网络、链路本地或保留地址。')
  }
  return url
}

export function inferModelProviderKind(value: string): ModelProviderKind {
  try {
    const url = new URL(value.trim())
    return isExplicitPrivateHostname(normalizeHostname(url.hostname))
      ? 'openai-compatible-local'
      : 'openai-compatible-remote'
  } catch {
    return 'openai-compatible-remote'
  }
}

/** Compares profile and submitted discovery URLs without credentials or fragments. */
export function modelBaseUrlIdentity(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    if (url.username || url.password) return undefined
    const pathname = `${url.pathname.replace(/\/+$/, '') || '/'}`
    return `${url.protocol}//${url.host}${pathname}`
  } catch {
    return undefined
  }
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function isExplicitPrivateHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === 'host.docker.internal' || hostname === 'host.containers.internal'
    || hostname.endsWith('.local')) return true
  return isIP(hostname) !== 0 && isPrivateAddress(hostname)
}

function isBlockedHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === 'host.docker.internal' || hostname === 'host.containers.internal'
    || hostname.endsWith('.local')) return true
  return isIP(hostname) !== 0 && isBlockedAddress(hostname)
}

function isPrivateAddress(address: string): boolean {
  const normalized = normalizeHostname(address)
  if (isIP(normalized) === 4) {
    const octets = parseIpv4(normalized)
    if (octets === undefined) return false
    const [first, second] = octets
    return first === 10 || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
  }
  if (isIP(normalized) === 6) {
    const value = parseIpv6(normalized)
    if (value === undefined) return false
    return inIpv6Range(value, 'fc00::', 7) || inIpv6Range(value, '::1', 128)
  }
  return false
}

function isBlockedAddress(address: string): boolean {
  const normalized = normalizeHostname(address)
  if (isIP(normalized) === 4) return isBlockedIpv4(normalized)
  if (isIP(normalized) !== 6) return true
  const value = parseIpv6(normalized)
  if (value === undefined) return true

  // IPv4-mapped IPv6 answers inherit the IPv4 policy.
  if (inIpv6Range(value, '::ffff:0:0', 96)) {
    const mapped = Number(value & 0xffff_ffffn)
    const octets = [mapped >>> 24, (mapped >>> 16) & 255, (mapped >>> 8) & 255, mapped & 255]
    if (isBlockedIpv4(octets.join('.'))) return true
  }

  return inIpv6Range(value, '::', 128)
    || inIpv6Range(value, '::1', 128)
    || inIpv6Range(value, 'fc00::', 7)
    || inIpv6Range(value, 'fe80::', 10)
    || inIpv6Range(value, 'ff00::', 8)
    || inIpv6Range(value, '100::', 64)
    || inIpv6Range(value, '2001:2::', 48)
    || inIpv6Range(value, '2001:10::', 28)
    || inIpv6Range(value, '2001:db8::', 32)
}

function isBlockedIpv4(address: string): boolean {
  const octets = parseIpv4(address)
  if (octets === undefined) return true
  const [first, second, third] = octets
  return first === 0 || first === 10 || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0)
    || (first === 192 && second === 168)
    || (first === 192 && second === 88 && third === 99)
    || (first === 192 && second === 0 && third === 2)
    || (first === 198 && (second === 18 || second === 19 || second === 51))
    || (first === 203 && second === 0 && third === 113)
    || first >= 224
}

function parseIpv4(value: string): [number, number, number, number] | undefined {
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined
  return parts as [number, number, number, number]
}

function parseIpv6(value: string): bigint | undefined {
  const input = value.toLowerCase().split('%')[0]!
  if (!input.includes(':')) return undefined
  const halves = input.split('::')
  if (halves.length > 2) return undefined
  const parseGroups = (part: string): number[] => {
    if (!part) return []
    const pieces = part.split(':')
    const groups: number[] = []
    for (const piece of pieces) {
      if (piece.includes('.')) {
        const ipv4 = parseIpv4(piece)
        if (ipv4 === undefined) return []
        groups.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3])
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
        groups.push(Number.parseInt(piece, 16))
      } else {
        return []
      }
    }
    return groups
  }
  const left = parseGroups(halves[0]!)
  const right = parseGroups(halves[1] ?? '')
  if (left.length + right.length > 8 || (halves.length === 1 && left.length !== 8)) return undefined
  const groups = halves.length === 2
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right]
    : left
  if (groups.length !== 8) return undefined
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n)
}

function inIpv6Range(value: bigint, startText: string, prefixLength: number): boolean {
  const start = parseIpv6(startText)
  if (start === undefined) return false
  if (prefixLength === 128) return value === start
  const shift = 128n - BigInt(prefixLength)
  return (value >> shift) === (start >> shift)
}
