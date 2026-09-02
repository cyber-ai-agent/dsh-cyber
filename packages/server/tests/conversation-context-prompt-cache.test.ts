import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import type { ConversationHistoryEntry, EmployeeBlueprint, EmployeeInstance } from '@dsh-cyber/contracts'
import { CONTEXT_LAYER_ORDER, composeContextLayer, contextEnvelopeLayers, promptCacheKey } from '@dsh-cyber/contracts'
import { SqliteStore } from '@dsh-cyber/persistence'

import { ConversationContextComposer } from '../src/services/conversation-context-composer.js'
import { EmployeeConversationMemoryService } from '../src/services/employee-conversation-memory-service.js'

const stores: SqliteStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

/** Long enough that a real provider would actually cache it. */
const PERSONA = [
  '你是长期驻留在本世界的内容员工，只引用自己真实参与过的经历。',
  '回答使用简洁中文，先给结论再给依据；不确定时直接说明不确定，不编造来源。',
  '未获授权的世界数据一律不读取，也不推断其内容或替用户猜测。',
  '每一轮都保持同一身份，不冒充其他角色，也不恢复创建时的旧模板身份。',
].join('\n')

function blueprint(): EmployeeBlueprint {
  return {
    schemaVersion: 1,
    id: 'cache.worker',
    version: 1,
    worldTemplateId: 'personal-world',
    displayName: '小林',
    role: '内容员工',
    summary: '负责测试提示缓存前缀',
    persona: PERSONA,
    requestedSkills: [],
    requestedCapabilities: [],
    createdAt: '2026-08-28T00:00:00.000Z',
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-context-prompt-cache-'))
  const store = await SqliteStore.open(join(root, 'cyber.sqlite'))
  stores.push(store)
  const workspace = store.createWorkspace({ name: '本地工作区' })
  const world = store.createWorld({ workspaceId: workspace.id, name: '缓存世界', templateId: 'personal-world' })
  store.saveBlueprint(blueprint())
  const employee = store.recruitEmployee({
    workspaceId: workspace.id,
    worldId: world.id,
    blueprintId: 'cache.worker',
    blueprintVersion: 1,
  })
  const session = store.createSession({
    workspaceId: workspace.id,
    worldId: world.id,
    kind: 'direct',
    title: '私聊',
    participants: [
      { participantId: 'owner', kind: 'owner' },
      { participantId: employee.id, kind: 'employee' },
    ],
  })
  const memory = new EmployeeConversationMemoryService(store)
  return { store, workspace, world, employee, session, composer: new ConversationContextComposer(store, memory) }
}

function turnHistory(employee: EmployeeInstance, turns: number): ConversationHistoryEntry[] {
  const entries: ConversationHistoryEntry[] = []
  for (let index = 1; index <= turns; index += 1) {
    entries.push({
      role: 'user',
      sequence: index * 2 - 1,
      speakerId: 'owner',
      speakerName: '用户',
      content: `第 ${index} 轮请求`,
      createdAt: `2026-08-28T00:${String(index).padStart(2, '0')}:00.000Z`,
    })
    entries.push({
      role: 'assistant',
      sequence: index * 2,
      speakerId: employee.id,
      speakerName: employee.displayName,
      content: `第 ${index} 轮回答`,
      createdAt: `2026-08-28T00:${String(index).padStart(2, '0')}:30.000Z`,
    })
  }
  return entries
}

describe('conversation context prompt cache', () => {
  it('declares a cache policy whose prefix survives every turn that only moves dynamic layers', async () => {
    const { employee, session, composer } = await setup()

    const first = await composer.compose({
      employee,
      persona: PERSONA,
      personaRevision: 1,
      conversationId: session.id,
      prompt: '第一轮请求',
      history: turnHistory(employee, 1),
      observedThroughSequence: 0,
    })
    const second = await composer.compose({
      employee,
      persona: PERSONA,
      personaRevision: 1,
      conversationId: session.id,
      prompt: '完全不同的第二轮请求',
      history: turnHistory(employee, 4),
      observedThroughSequence: 2,
    })

    // The dynamic layers really did move between the two turns.
    expect(second.envelope.currentRequest.contentHash).not.toBe(first.envelope.currentRequest.contentHash)
    expect(second.envelope.recentConversation?.contentHash)
      .not.toBe(first.envelope.recentConversation?.contentHash)

    const policy = second.envelope.promptCache
    expect(policy?.enabled).toBe(true)
    expect(policy?.scope).toBe('employee')
    expect(policy?.namespace).toBe(`${employee.worldId}/${employee.id}`)
    expect(policy?.retentionHint).toBe('long')
    expect(policy?.stablePrefixHash).toBe(second.envelope.stableContextHash)
    expect(policy).toEqual(first.envelope.promptCache)
    expect(promptCacheKey(policy!)).toBe(promptCacheKey(first.envelope.promptCache!))
  })

  it('moves the cache identity when the persona behind the prefix changes', async () => {
    const { employee, session, composer } = await setup()
    const base = {
      employee,
      conversationId: session.id,
      prompt: '同一个请求',
      history: turnHistory(employee, 2),
      observedThroughSequence: 0,
    }
    const before = await composer.compose({ ...base, persona: PERSONA, personaRevision: 1 })
    const after = await composer.compose({
      ...base,
      persona: `${PERSONA}\n从今天起，所有结论都要附上可核对的出处。`,
      personaRevision: 2,
    })
    expect(after.envelope.promptCache?.stablePrefixHash)
      .not.toBe(before.envelope.promptCache?.stablePrefixHash)
    expect(promptCacheKey(after.envelope.promptCache!))
      .not.toBe(promptCacheKey(before.envelope.promptCache!))
  })

  it('emits the cacheable prefix first and every dynamic layer after it', async () => {
    const { employee, session, composer } = await setup()
    const composed = await composer.compose({
      employee,
      persona: PERSONA,
      personaRevision: 1,
      conversationId: session.id,
      prompt: '这一轮的请求',
      history: turnHistory(employee, 3),
      observedThroughSequence: 0,
    })
    const kinds = contextEnvelopeLayers(composed.envelope).map((layer) => layer.kind)
    expect(kinds[0]).toBe('stable-identity')
    expect(kinds.at(-1)).toBe('current-request')
    expect(kinds).toEqual(CONTEXT_LAYER_ORDER.filter((kind) => kinds.includes(kind)))
    // The identity never leaks into the dynamic prompt body the lane renders.
    expect(composed.prompt).not.toContain(PERSONA)
    expect(composed.prompt.endsWith('这一轮的请求')).toBe(true)
  })

  it('gives a group lane its own partition and a shorter retention', async () => {
    const { store, workspace, world, employee, composer } = await setup()
    const groupSession = store.createSession({
      workspaceId: workspace.id,
      worldId: world.id,
      kind: 'group',
      title: '协作',
      participants: [
        { participantId: 'owner', kind: 'owner' },
        { participantId: employee.id, kind: 'employee' },
      ],
    })
    const composed = await composer.compose({
      employee,
      persona: PERSONA,
      personaRevision: 1,
      conversationId: groupSession.id,
      prompt: '协作里的请求',
      history: turnHistory(employee, 2),
      observedThroughSequence: 0,
    })
    expect(composed.coverage.lane).toBe('group')
    expect(composed.envelope.promptCache?.retentionHint).toBe('short')
    // The partition is the character, never the conversation's participants.
    expect(composed.envelope.promptCache?.namespace).toBe(`${employee.worldId}/${employee.id}`)
  })

  it('places the world rules in the prefix and hashes them there, so only a settings edit moves the key', async () => {
    const { employee, session, composer } = await setup()
    const rules = (revision: string, extra = '') => composeContextLayer({
      id: `world-context:${employee.worldId}`,
      kind: 'world-context',
      revision,
      text: [
        '[当前世界设定]',
        '世界观：雨夜学院的每一条结论都要附上出处。',
        '当前世界与其他世界的数据、文件、记忆相互隔离。',
        extra,
      ].filter(Boolean).join('\n'),
      sourceRefs: [{ kind: 'world', id: employee.worldId, revision }],
    })
    const base = { employee, persona: PERSONA, personaRevision: 1, conversationId: session.id, observedThroughSequence: 0 }

    const first = await composer.compose({ ...base, worldContext: rules('1'), prompt: '第一轮请求', history: turnHistory(employee, 1) })
    const second = await composer.compose({ ...base, worldContext: rules('1'), prompt: '完全不同的第二轮请求', history: turnHistory(employee, 4) })
    const edited = await composer.compose({ ...base, worldContext: rules('2', '新增：讲解引用的事实保留来源。'), prompt: '第一轮请求', history: turnHistory(employee, 1) })
    const bare = await composer.compose({ ...base, prompt: '第一轮请求', history: turnHistory(employee, 1) })

    // The rules are the second layer, directly behind the identity, and the
    // dynamic prompt body the lane renders never carries them.
    const kinds = contextEnvelopeLayers(second.envelope).map((layer) => layer.kind)
    expect(kinds.slice(0, 2)).toEqual(['stable-identity', 'world-context'])
    expect(kinds).toEqual(CONTEXT_LAYER_ORDER.filter((kind) => kinds.includes(kind)))
    expect(second.prompt).not.toContain('[当前世界设定]')

    // Dynamic layers moved; the prefix did not.
    expect(second.envelope.currentRequest.contentHash).not.toBe(first.envelope.currentRequest.contentHash)
    expect(second.envelope.promptCache?.stablePrefixHash).toBe(first.envelope.promptCache?.stablePrefixHash)
    expect(second.envelope.promptCache?.stablePrefixHash).toBe(second.envelope.stableContextHash)
    expect(promptCacheKey(second.envelope.promptCache!)).toBe(promptCacheKey(first.envelope.promptCache!))

    // The rules are part of the hashed prefix: editing them, or dropping them,
    // is a different cache identity.
    expect(edited.envelope.promptCache?.stablePrefixHash).not.toBe(first.envelope.promptCache?.stablePrefixHash)
    expect(bare.envelope.promptCache?.stablePrefixHash).not.toBe(first.envelope.promptCache?.stablePrefixHash)
    expect(bare.envelope.worldContext).toBeUndefined()
  })
})
