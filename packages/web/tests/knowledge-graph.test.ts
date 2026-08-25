import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { KnowledgeGraph } from '../src/features/knowledge/KnowledgeGraph.js'
import {
  filterKnowledgeGraph,
  layoutKnowledgeGraph,
  normalizeKnowledgeGraph,
  type KnowledgeGraphNode,
} from '../src/features/knowledge/knowledge-graph.js'

const canonicalResponse = {
  worldId: 'world-1',
  generatedAt: '2026-08-26T08:00:00.000Z',
  entities: [
    { id: 'entity-a', type: 'character', canonicalName: '阿开', summary: '负责当前世界的协作。' },
    { id: 'entity-b', type: 'project', canonicalName: '知识整理', summary: '将资料转为可追溯知识。' },
  ],
  claims: [
    { id: 'claim-a', type: 'fact', subjectEntityId: 'entity-a', predicate: '负责', objectEntityId: 'entity-b', confidence: 0.9, status: 'active', source: 'auto', evidenceIds: ['evidence-1'] },
  ],
  relations: [
    { id: 'relation-a', fromEntityId: 'entity-a', toEntityId: 'entity-b', predicate: '参与', confidence: 0.84, status: 'active', source: 'auto', evidenceIds: ['evidence-1'] },
  ],
  evidence: [
    { id: 'evidence-1', sourceType: 'conversation', sessionId: 'session-1', messageId: 'message-1', sequence: 4, excerpt: '阿开参与知识整理。', sourceWeight: 0.8 },
  ],
}

describe('knowledge graph normalization', () => {
  it('normalizes the canonical entities, claims, relations and evidence shape', () => {
    const snapshot = normalizeKnowledgeGraph(canonicalResponse, 'world-1')
    expect(snapshot.nodes[0]?.name).toBe('阿开')
    expect(snapshot.nodes[0]?.type).toBe('character')
    expect(snapshot.nodes[0]?.source).toBe('conversation')
    expect(snapshot.claims[0]?.subjectEntityId).toBe('entity-a')
    expect(snapshot.relations[0]?.fromEntityId).toBe('entity-a')
    expect(snapshot.relations[0]?.toEntityId).toBe('entity-b')
    expect(snapshot.relations[0]?.predicate).toBe('参与')
    expect(snapshot.evidence[0]?.sourceType).toBe('conversation')
    expect(snapshot.nodes[0]?.relations[0]?.targetId).toBe('entity-b')
  })

  it('keeps a 300-node overview in a bounded layout and supports depth one focus', () => {
    const nodes = Array.from({ length: 300 }, (_, index) => makeNode(`node-${index}`))
    const edges = nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, sourceId: `node-${index}`, targetId: node.id, label: '关联', confidence: 0.8, status: 'active' as const, evidenceIds: [] }))
    const snapshot = { worldId: 'world-1', nodes, edges, claims: [], relations: [], evidence: [] }
    expect(layoutKnowledgeGraph(nodes).size).toBe(300)
    const focused = filterKnowledgeGraph(snapshot, { query: '', entityType: 'all', source: 'all', depth: 1 }, 'node-0')
    expect(focused.nodes.map((node) => node.id)).toEqual(['node-0', 'node-1'])
  })
})

describe('knowledge graph UI', () => {
  it('renders a real canvas surface with accessible graph controls and settings', () => {
    const snapshot = normalizeKnowledgeGraph(canonicalResponse, 'world-1')
    const markup = renderToStaticMarkup(createElement(KnowledgeGraph, {
      worldId: 'world-1',
      demoMode: true,
      initialSnapshot: snapshot,
      onOpenLibrary: () => undefined,
    }))
    expect(markup).toContain('<canvas')
    expect(markup).toContain('搜索实体')
    expect(markup).toContain('实体类型')
    expect(markup).toContain('来源')
    expect(markup).toContain('深度')
    expect(markup).toContain('全屏显示')
    expect(markup).toContain('对话、资料与产物会在后台整理为有证据的长期知识')
    expect(markup).toContain('自动整理')
    expect(markup).toContain('提取模型')
    expect(markup).toContain('开始整理')
  })
})

function makeNode(id: string): KnowledgeGraphNode {
  return {
    id,
    name: id,
    type: 'topic',
    source: 'manual',
    sourceLabel: '手动整理',
    summary: '测试实体',
    claims: [],
    relations: [],
    evidence: [],
  }
}
