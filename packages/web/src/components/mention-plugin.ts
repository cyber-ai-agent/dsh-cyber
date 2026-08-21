import type { PhrasingContent, Root } from 'mdast'
import { visit } from 'unist-util-visit'

declare module 'mdast' {
  interface EmphasisData {
    hName?: string
  }
}

export const MENTION_PATTERN = /(?<![A-Za-z0-9])(@[^\s，。；：、!?！？]+)/g

/**
 * remark 插件：把消息正文里的 @提及 转成带 hName 标记的 emphasis 节点。
 * mdast-util-to-hast 依据 data.hName 直接生成 <mark> 元素，因此提及在
 * 段落、列表、标题等任意位置都能正确高亮，且不影响普通 *斜体* 语义。
 */
export function mentionPlugin() {
  return (tree: Root) => {
    visit(tree, 'text', (node, index, parent) => {
      if (index === undefined || parent === undefined || !node.value.includes('@')) return
      const parts = node.value.split(MENTION_PATTERN).filter((part): part is string => part.length > 0)
      if (parts.length === 1) return
      parent.children.splice(index, 1, ...parts.map((part: string) => {
        if (part.startsWith('@')) {
          const mention: PhrasingContent = {
            type: 'emphasis',
            data: { hName: 'mark' },
            children: [{ type: 'text', value: part }],
          }
          return mention
        }
        const text: PhrasingContent = { type: 'text', value: part }
        return text
      }))
    })
  }
}
