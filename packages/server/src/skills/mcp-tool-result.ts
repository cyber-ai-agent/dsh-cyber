import { isSensitiveCredentialKey, isSensitiveToolPath, redactCredentialPatternText, redactToolTraceText } from '@dsh-cyber/contracts'

import type { CharacterSkillExecutionResult } from './skill-adapter.js'

const MAX_DETAIL = 12_000
const MAX_SECTION = 5_500
const MAX_ITEMS = 40
const OMITTED = '［内容已省略］'
const TRUNCATED = '［内容因结果预算已截断］'
const PRIVATE_FIELD = /^(?:prompt|system[_-]?prompt|developer[_-]?prompt|full[_-]?prompt|messages|reasoning|reasoning[_-]?content|analysis|chain[_-]?of[_-]?thought)$/i
// Providers namespace credentials (client_secret/sessionToken). Drop the whole
// value, including arrays and objects; text regexes only protect scalar values.
// Ordinary source filenames such as token-counter.ts are not credential keys.
const CREDENTIAL_FIELD = /^(?:[a-z0-9_-]*)(?:api[_-]?key|access[_-]?key|private[_-]?key|session[_-]?key|token|secret|password|passwd|passphrase|credential)s?$/i

/** Only a bounded, credential-free evidence projection enters the action ledger. */
export function projectMcpToolResult(
  service: string,
  toolName: string,
  value: unknown,
  redact: (text: string) => string = redactCredentialPatternText,
): CharacterSkillExecutionResult {
  const result = record(value)
  if (result === undefined
    || (result.isError !== undefined && typeof result.isError !== 'boolean')
    || (result.isError !== true && !Array.isArray(result.content) && record(result.structuredContent) === undefined)) {
    return { status: 'outcome-unknown', detail: 'MCP 返回格式无法识别，调用结果未知；不得自动重试' }
  }
  const clean = (text: string, limit = MAX_SECTION): string => clip(redactToolTraceText(redact(text), limit + 1), limit)
  let remaining = 200
  const project = (item: unknown, depth = 0): unknown => {
    if (--remaining < 0 || depth > 6) return TRUNCATED
    if (typeof item === 'string') return clean(item)
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') return Number.isFinite(item) ? item : OMITTED
    if (Array.isArray(item)) {
      return [...item.slice(0, MAX_ITEMS).map((entry) => project(entry, depth + 1)), ...(item.length > MAX_ITEMS ? [TRUNCATED] : [])]
    }
    const object = record(item)
    if (object === undefined) return OMITTED
    const sensitiveFile = ['path', 'uri', 'filename'].some((key) => typeof object[key] === 'string' && sensitivePath(object[key]))
    const binaryMedia = object.type === 'image' || object.type === 'audio'
      || (typeof object.mimeType === 'string' && /^(?:image|audio)\//i.test(object.mimeType))
    const entries = Object.entries(object)
    return Object.fromEntries([
      ...entries.slice(0, MAX_ITEMS).map(([key, entry]) => [
        clean(key, 160),
        isSensitiveCredentialKey(key) || CREDENTIAL_FIELD.test(key) || PRIVATE_FIELD.test(key)
          || ((sensitiveFile || binaryMedia) && /^(?:text|content|data|blob)$/i.test(key))
          ? OMITTED : project(entry, depth + 1),
      ]),
      ...(entries.length > MAX_ITEMS ? [['…', TRUNCATED]] : []),
    ])
  }
  const textEvidence = (text: string): string => {
    // MCP servers often put JSON in text blocks. Preserve its values while
    // applying the same field-level exclusions as structuredContent.
    try { return JSON.stringify(project(JSON.parse(text)), null, 2) }
    catch { return clean(text) }
  }
  const content = Array.isArray(result.content) ? result.content : []
  const blocks = content.slice(0, MAX_ITEMS).map((item) => {
    const block = record(item)
    if (block === undefined) return '［无法读取的内容块］'
    if (block.type === 'text' && typeof block.text === 'string') return textEvidence(block.text)
    if (block.type === 'resource_link') {
      return JSON.stringify(project({ type: block.type, name: block.name, uri: block.uri, description: block.description }), null, 2)
    }
    if (block.type === 'resource') {
      const resource = record(block.resource)
      if (resource !== undefined) {
        return JSON.stringify(project({ uri: resource.uri, mimeType: resource.mimeType,
          ...(typeof resource.text === 'string' ? { text: textEvidence(resource.text) } : { content: '［二进制资源未包含］' }),
        }), null, 2)
      }
    }
    // Never serialize image/audio data, blobs, provider metadata or unknown blocks.
    return '［非文本或不支持的内容块未包含］'
  })
  if (content.length > MAX_ITEMS) blocks.push(TRUNCATED)
  const structured = record(result.structuredContent)
  const status = result.isError === true ? 'failed' : 'executed'
  const detail = [
    `MCP 服务 ${service} 的工具 ${toolName} ${status === 'failed' ? '报告执行失败' : '已执行'}`,
    ...(blocks.length === 0 ? [] : [`返回内容：\n${clean(blocks.join('\n\n'))}`]),
    ...(structured === undefined ? [] : [`结构化结果：\n${clean(JSON.stringify(project(structured), null, 2))}`]),
    ...(blocks.length === 0 && structured === undefined ? ['服务未返回可读内容。'] : []),
    '仅保留有界、脱敏的结果摘录；原始结果未持久化。',
  ].join('\n')
  return { status, detail: clean(detail, MAX_DETAIL) }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function clip(text: string, maximum: number): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum - TRUNCATED.length)}${TRUNCATED}`
}

function sensitivePath(value: string): boolean {
  if (isSensitiveToolPath(value)) return true
  try { return isSensitiveToolPath(decodeURIComponent(new URL(value).pathname)) }
  catch { return false }
}
