import { redactCredentialPatternText, redactToolTraceText } from '@dsh-cyber/contracts'
import type { JsonObject, JsonValue, WorldTraceEntry } from '@dsh-cyber/contracts'
import { clipToolEvidence } from '@dsh-cyber/harness-adapter'

const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passphrase|secret|api[-_]?key|access[-_]?key|private[-_]?key|access[-_]?token|refresh[-_]?token|token|credential|credentials)$/i
const SENSITIVE_TEXT = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:api[-_ ]?key|authorization|password|token|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:session|auth)[_-]?cookie\s*[:=]\s*[^\s,;]+/gi,
]

export class TraceSanitizer {
  readonly #credentialRedact: (value: string, scopeId?: string) => string
  readonly #scopeForEntry: ((worldId: string) => string | undefined) | undefined

  constructor(options: { redactText?: (value: string, scopeId?: string) => string; scopeForEntry?: (worldId: string) => string | undefined } = {}) {
    this.#credentialRedact = options.redactText ?? redactCredentialPatternText
    this.#scopeForEntry = options.scopeForEntry
  }

  /** Credential-only pass that preserves line breaks for evidence previews. */
  redact(value: string, scopeId?: string): string {
    return this.#credentialRedact(value, scopeId)
  }

  text(value: string, maximumLength = 500, scopeId?: string): string {
    let sanitized = redactToolTraceText(this.#credentialRedact(value, scopeId), Math.max(maximumLength, 4_000)).replaceAll(/\s+/g, ' ').trim()
    for (const pattern of SENSITIVE_TEXT) sanitized = sanitized.replace(pattern, '[已隐藏敏感信息]')
    return sanitized.length <= maximumLength
      ? sanitized
      : `${sanitized.slice(0, Math.max(0, maximumLength - 1))}…`
  }

  json(value: JsonObject): JsonObject {
    return this.#record(value)
  }

  entry(entry: WorldTraceEntry): WorldTraceEntry {
    const scopeId = this.#scopeForEntry?.(entry.worldId) ?? entry.worldId
    const summary = this.text(entry.summary, 160, scopeId)
    const detail = entry.detail === undefined ? undefined : this.text(entry.detail, 500, scopeId)
    const reasoningSummary = entry.reasoningSummary === undefined ? undefined : this.text(entry.reasoningSummary, 1_200, scopeId)
    // Tool evidence is variableized before clipping; labels and descriptions
    // use the same redaction path because provider names are runtime data.
    const tools = entry.tools?.map((tool) => ({
      ...tool,
      callId: this.text(tool.callId, 160, scopeId),
      ...(tool.name === undefined ? {} : { name: this.text(tool.name, 160, scopeId) }),
      ...(tool.outputReference === undefined ? {} : { outputReference: this.text(tool.outputReference, 160, scopeId) }),
      label: this.text(tool.label, 200, scopeId),
      ...(tool.description === undefined ? {} : { description: this.text(tool.description, 300, scopeId) }),
      ...(tool.input === undefined ? {} : (() => {
        const redacted = this.#credentialRedact(tool.input, scopeId)
        const bounded = clipToolEvidence(redacted)
        return {
          input: bounded.value,
          ...(tool.inputTruncated || bounded.truncated ? { inputTruncated: true } : {}),
          ...(tool.inputRedacted || redacted !== tool.input ? { inputRedacted: true } : {}),
        }
      })()),
      ...(tool.output === undefined ? {} : (() => {
        const redacted = this.#credentialRedact(tool.output, scopeId)
        const bounded = clipToolEvidence(redacted)
        return {
          output: bounded.value,
          outputTruncated: tool.outputTruncated || bounded.truncated,
          ...(tool.outputRedacted || redacted !== tool.output ? { outputRedacted: true } : {}),
        }
      })()),
    }))
    // Artifact titles are author-supplied text and reach the trace verbatim, so
    // they pass through the same redaction as every other displayed string.
    const artifacts = entry.artifacts?.map((artifact) => ({
      ...artifact,
      artifactId: this.text(artifact.artifactId, 160, scopeId),
      title: this.text(artifact.title, 200, scopeId) || '未命名产物',
    }))
    // A task title is owner-typed and reaches the card verbatim, like an
    // artifact title. The id stays untouched: it is what a filter matches on.
    const taskTitle = entry.taskTitle === undefined ? undefined : this.text(entry.taskTitle, 160, scopeId)
    const {
      detail: _originalDetail,
      reasoningSummary: _originalReasoning,
      tools: _originalTools,
      artifacts: _originalArtifacts,
      taskTitle: _originalTaskTitle,
      ...rest
    } = entry
    return {
      ...rest,
      summary: summary || '世界活动已更新',
      ...(detail === undefined || detail.length === 0 ? {} : { detail }),
      ...(reasoningSummary === undefined || reasoningSummary.length === 0 ? {} : { reasoningSummary }),
      ...(tools === undefined ? {} : { tools }),
      ...(artifacts === undefined ? {} : { artifacts }),
      ...(taskTitle === undefined || taskTitle.length === 0 ? {} : { taskTitle }),
    }
  }

  #record(value: JsonObject): JsonObject {
    const output: JsonObject = {}
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        const safe = typeof item === 'string' ? this.#credentialRedact(item) : '[已隐藏敏感信息]'
        output[key] = safe === item ? '[已隐藏敏感信息]' : safe
        continue
      }
      output[key] = this.#value(item)
    }
    return output
  }

  #value(value: JsonValue): JsonValue {
    if (typeof value === 'string') return this.text(value)
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => this.#value(item))
    if (value !== null && typeof value === 'object') return this.#record(value)
    return value
  }
}
