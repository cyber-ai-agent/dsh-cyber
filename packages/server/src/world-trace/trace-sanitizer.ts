import type { JsonObject, JsonValue, WorldTraceEntry } from '@dsh-cyber/contracts'

const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|password|passphrase|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|token|credential)$/i
const SENSITIVE_TEXT = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:api[-_ ]?key|authorization|password|token|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:session|auth)[_-]?cookie\s*[:=]\s*[^\s,;]+/gi,
]

export class TraceSanitizer {
  text(value: string, maximumLength = 500): string {
    let sanitized = value.replaceAll(/\s+/g, ' ').trim()
    for (const pattern of SENSITIVE_TEXT) sanitized = sanitized.replace(pattern, '[已隐藏敏感信息]')
    return sanitized.length <= maximumLength
      ? sanitized
      : `${sanitized.slice(0, Math.max(0, maximumLength - 1))}…`
  }

  json(value: JsonObject): JsonObject {
    return this.#record(value)
  }

  entry(entry: WorldTraceEntry): WorldTraceEntry {
    const summary = this.text(entry.summary, 160)
    const detail = entry.detail === undefined ? undefined : this.text(entry.detail, 500)
    const reasoningSummary = entry.reasoningSummary === undefined ? undefined : this.text(entry.reasoningSummary, 1_200)
    const tools = entry.tools?.map((tool) => ({
      ...tool,
      callId: this.text(tool.callId, 160),
      ...(tool.name === undefined ? {} : { name: this.text(tool.name, 160) }),
      label: this.text(tool.label, 200),
      ...(tool.description === undefined ? {} : { description: this.text(tool.description, 300) }),
    }))
    // Artifact titles are author-supplied text and reach the trace verbatim, so
    // they pass through the same redaction as every other displayed string.
    const artifacts = entry.artifacts?.map((artifact) => ({
      ...artifact,
      artifactId: this.text(artifact.artifactId, 160),
      title: this.text(artifact.title, 200) || '未命名产物',
    }))
    const {
      detail: _originalDetail,
      reasoningSummary: _originalReasoning,
      tools: _originalTools,
      artifacts: _originalArtifacts,
      ...rest
    } = entry
    return {
      ...rest,
      summary: summary || '世界活动已更新',
      ...(detail === undefined || detail.length === 0 ? {} : { detail }),
      ...(reasoningSummary === undefined || reasoningSummary.length === 0 ? {} : { reasoningSummary }),
      ...(tools === undefined ? {} : { tools }),
      ...(artifacts === undefined ? {} : { artifacts }),
    }
  }

  #record(value: JsonObject): JsonObject {
    const output: JsonObject = {}
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        output[key] = '[已隐藏敏感信息]'
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
