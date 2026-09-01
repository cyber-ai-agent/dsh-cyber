import { describe, expect, it } from 'vitest'

import {
  CONTEXT_LAYER_ORDER,
  PROMPT_CACHE_MIN_PREFIX_TOKENS,
  composeContextEnvelope,
  composeContextLayer,
  composeStableIdentity,
  contextEnvelopeLayers,
  derivePromptCachePolicy,
  promptCacheKey,
  stableContextHash,
  type ContextLayer,
} from '../src/index.js'

const PERSONA = [
  '你是长期驻留的内容员工，只引用自己真实参与过的经历。',
  '回答保持简洁中文，先给结论再给依据，不确定时直接说明不确定。',
  '未获授权的世界数据一律不读取，也不推断其内容。',
  '每一轮都保持同一身份，不冒充其他角色，也不恢复旧模板身份。',
].join('\n')

function identity(): ContextLayer {
  return composeStableIdentity({
    employeeId: 'employee-1',
    persona: { text: PERSONA, revision: 3 },
    worldAuthority: { worldId: 'world-1', role: '普通角色', permissionGrants: ['world.read', 'world.artifact.read'] },
    permissionGuidance: { mode: 'read-only', text: '当前工作目录只读；文件写入和命令工具由运行时关闭。' },
    skillInstructions: [{ skillId: 'writing', text: '先列提纲再展开正文。' }],
  })
}

function envelopeForTurn(turn: number) {
  const stableIdentity = identity()
  return composeContextEnvelope({
    stableIdentity,
    promptCache: derivePromptCachePolicy({
      stablePrefixHash: stableContextHash(stableIdentity),
      namespace: 'world-1/employee-1',
      scope: 'employee',
      stablePrefixTokens: stableIdentity.tokenEstimate,
      retentionHint: 'long',
    }),
    retrievedMemories: composeContextLayer({
      id: 'retrieved-memories:employee-1',
      kind: 'retrieved-memories',
      text: `第 ${turn} 轮检索到的记忆`,
      sourceRefs: [{ kind: 'memory', id: `memory-${turn}` }],
    }),
    recentConversation: composeContextLayer({
      id: 'recent-conversation:session-1',
      kind: 'recent-conversation',
      text: `${turn} · 用户：第 ${turn} 轮请求`,
      sourceRefs: [{ kind: 'session', id: 'session-1' }],
    }),
    currentRequest: composeContextLayer({
      id: `request:turn-${turn}`,
      kind: 'current-request',
      text: `第 ${turn} 轮请求`,
      sourceRefs: [{ kind: 'request', id: `turn-${turn}` }],
    }),
  })
}

describe('prompt cache policy', () => {
  it('keeps the stable prefix hash and cache key fixed while only dynamic layers change', () => {
    const first = envelopeForTurn(1)
    const second = envelopeForTurn(2)

    // Every dynamic layer really did move.
    expect(second.retrievedMemories?.contentHash).not.toBe(first.retrievedMemories?.contentHash)
    expect(second.recentConversation?.contentHash).not.toBe(first.recentConversation?.contentHash)
    expect(second.currentRequest.contentHash).not.toBe(first.currentRequest.contentHash)

    // And the prefix did not. This is the whole property caching lives on.
    expect(second.stableContextHash).toBe(first.stableContextHash)
    expect(second.promptCache).toEqual(first.promptCache)
    expect(second.promptCache?.stablePrefixHash).toBe(second.stableContextHash)
    expect(promptCacheKey(second.promptCache!)).toBe(promptCacheKey(first.promptCache!))
  })

  it('puts the cacheable prefix first and every dynamic layer after it', () => {
    const layers = contextEnvelopeLayers(envelopeForTurn(1))
    expect(layers[0]!.kind).toBe('stable-identity')
    const kinds = layers.map((layer) => layer.kind)
    const declaredOrder = CONTEXT_LAYER_ORDER.filter((kind) => kinds.includes(kind))
    expect(kinds).toEqual([...declaredOrder])
    expect(kinds.at(-1)).toBe('current-request')
  })

  it('changes the cache key when the prefix itself changes', () => {
    const changed = composeStableIdentity({
      employeeId: 'employee-1',
      persona: { text: `${PERSONA}\n新增一条长期约定。`, revision: 4 },
    })
    const policy = derivePromptCachePolicy({
      stablePrefixHash: stableContextHash(changed),
      namespace: 'world-1/employee-1',
      scope: 'employee',
      stablePrefixTokens: changed.tokenEstimate,
    })
    expect(promptCacheKey(policy)).not.toBe(promptCacheKey(envelopeForTurn(1).promptCache!))
  })

  it('never shares one cache key across two namespaces holding the same prefix', () => {
    const stableIdentity = identity()
    const shared = {
      stablePrefixHash: stableContextHash(stableIdentity),
      scope: 'employee' as const,
      stablePrefixTokens: stableIdentity.tokenEstimate,
    }
    const mine = derivePromptCachePolicy({ ...shared, namespace: 'world-1/employee-1' })
    const theirs = derivePromptCachePolicy({ ...shared, namespace: 'world-1/employee-2' })
    expect(mine.stablePrefixHash).toBe(theirs.stablePrefixHash)
    expect(promptCacheKey(mine)).not.toBe(promptCacheKey(theirs))
  })

  it('declares no cache identity for a prefix no provider could ever cache', () => {
    const tiny = composeStableIdentity({ employeeId: 'employee-1', persona: { text: '简短设定。', revision: 1 } })
    expect(tiny.tokenEstimate).toBeLessThan(PROMPT_CACHE_MIN_PREFIX_TOKENS)
    const policy = derivePromptCachePolicy({
      stablePrefixHash: stableContextHash(tiny),
      namespace: 'world-1/employee-1',
      scope: 'employee',
      stablePrefixTokens: tiny.tokenEstimate,
    })
    expect(policy.enabled).toBe(false)
    expect(promptCacheKey(policy)).toBeUndefined()
  })

  it('honours a caller veto even for a large stable prefix', () => {
    const stableIdentity = identity()
    const policy = derivePromptCachePolicy({
      stablePrefixHash: stableContextHash(stableIdentity),
      namespace: 'world-1/employee-1',
      scope: 'employee',
      stablePrefixTokens: stableIdentity.tokenEstimate,
      enabled: false,
    })
    expect(policy.enabled).toBe(false)
    expect(promptCacheKey(policy)).toBeUndefined()
  })
})
