import { Graph, Books } from '@phosphor-icons/react'

export interface KnowledgeGraphProps {
  onOpenLibrary(): void
}

/**
 * The graph is intentionally an honest empty state in Library V1. A graph
 * renderer belongs to the later evidence-backed graph milestone; this view
 * must never imply that placeholder nodes are real world knowledge.
 */
export function KnowledgeGraph({ onOpenLibrary }: KnowledgeGraphProps) {
  return <section className="knowledge-graph" aria-label="知识图谱空状态">
    <div className="knowledge-graph__empty">
      <span className="knowledge-graph__mark" aria-hidden="true"><Graph size={25} /></span>
      <h3>知识图谱还没有内容</h3>
      <p>图谱会在整理出有证据的实体、事实和关系后呈现。先从知识库导入资料，保留每份资料的来源。</p>
      <button type="button" className="knowledge-button knowledge-button--primary" onClick={onOpenLibrary}><Books size={17} aria-hidden="true" />前往知识库</button>
    </div>
  </section>
}
