import { describe, expect, it } from 'vitest'
import type { Root } from 'mdast'

import { mentionPlugin, MENTION_PATTERN } from '../src/components/mention-plugin.js'

function apply(text: string): unknown[] {
  const tree: Root = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
  }
  mentionPlugin()(tree)
  const paragraph = tree.children[0]
  return paragraph.type === 'paragraph' ? paragraph.children : []
}

describe('mention remark plugin', () => {
  it('wraps inline mentions in emphasis nodes with hName mark', () => {
    const nodes = apply('项目二：@阿帆 修复问题')
    expect(nodes).toHaveLength(3)
    expect(nodes[0]).toMatchObject({ type: 'text', value: '项目二：' })
    expect(nodes[1]).toMatchObject({ type: 'emphasis', data: { hName: 'mark' }, children: [{ type: 'text', value: '@阿帆' }] })
    expect(nodes[2]).toMatchObject({ type: 'text', value: ' 修复问题' })
  })

  it('wraps mentions at the start of a paragraph', () => {
    const nodes = apply('@小周 请确认。')
    expect(nodes[0]).toMatchObject({ type: 'emphasis', data: { hName: 'mark' }, children: [{ type: 'text', value: '@小周' }] })
  })

  it('does not split plain text without mentions', () => {
    const nodes = apply('没有提及的普通文本')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ type: 'text', value: '没有提及的普通文本' })
  })

  it('handles multiple mentions in one text node', () => {
    const nodes = apply('@阿帆 和 @小周 都确认')
    expect(nodes).toHaveLength(4)
    expect(nodes.filter((node) => node.type === 'emphasis')).toHaveLength(2)
  })

  it('matches mention tokens and ignores email addresses', () => {
    expect('@阿帆'.match(MENTION_PATTERN)).toEqual(['@阿帆'])
    expect('@小周 请确认'.match(MENTION_PATTERN)).toEqual(['@小周'])
    expect('email@example.com'.match(MENTION_PATTERN)).toBeNull()
    expect('word@前后'.match(MENTION_PATTERN)).toBeNull()
  })
})
