import { lazy, Suspense, useState } from 'react'
import type { World } from '@dsh-cyber/contracts'

import { KnowledgeLibrary } from './KnowledgeLibrary.js'
import {
  useWorldKnowledge,
  type KnowledgeCollection,
  type KnowledgeDocument,
} from './useWorldKnowledge.js'
import './knowledge.css'

const KnowledgeGraph = lazy(async () => {
  const module = await import('./KnowledgeGraph.js')
  return { default: module.KnowledgeGraph }
})

export interface KnowledgeDockProps {
  world: World
  demoMode?: boolean
  initialCollections?: KnowledgeCollection[]
  initialDocuments?: KnowledgeDocument[]
}

type KnowledgeView = 'graph' | 'library'

const EMPTY_COLLECTIONS: KnowledgeCollection[] = []
const EMPTY_DOCUMENTS: KnowledgeDocument[] = []

export function KnowledgeDock({ world, demoMode = false, initialCollections, initialDocuments }: KnowledgeDockProps) {
  const [view, setView] = useState<KnowledgeView>('library')
  const state = useWorldKnowledge({
    worldId: world.id,
    enabled: !demoMode,
    initialCollections: initialCollections ?? EMPTY_COLLECTIONS,
    initialDocuments: initialDocuments ?? EMPTY_DOCUMENTS,
  })

  return <section className="knowledge-dock" aria-label={`${world.name}知识`}>
    <header className="knowledge-dock__header">
      <div>
        <span className="knowledge-dock__kicker">世界知识</span>
        <h2>知识</h2>
        <p>原始资料与有来源的长期参考。</p>
      </div>
      <span className="knowledge-dock__scope" title="当前世界范围">{world.name}</span>
    </header>
    <nav className="knowledge-switcher" role="tablist" aria-label="知识视图">
      <button id="knowledge-tab-graph" type="button" role="tab" aria-selected={view === 'graph'} aria-controls="knowledge-panel-graph" className={view === 'graph' ? 'is-active' : ''} onClick={() => setView('graph')}><span>知识图谱</span><small>实体关系</small></button>
      <button id="knowledge-tab-library" type="button" role="tab" aria-selected={view === 'library'} aria-controls="knowledge-panel-library" className={view === 'library' ? 'is-active' : ''} onClick={() => setView('library')}><span>知识库</span><small>{state.documents.length} 份资料</small></button>
    </nav>
    <div id={view === 'graph' ? 'knowledge-panel-graph' : 'knowledge-panel-library'} className="knowledge-dock__content" role="tabpanel" aria-labelledby={view === 'graph' ? 'knowledge-tab-graph' : 'knowledge-tab-library'} tabIndex={0}>
      {view === 'graph' ? <Suspense fallback={<div className="knowledge-state" role="status"><span className="knowledge-graph__mark" aria-hidden="true">…</span><strong>正在载入知识图谱…</strong></div>}><KnowledgeGraph worldId={world.id} workspaceId={world.workspaceId} demoMode={demoMode} onOpenLibrary={() => setView('library')} /></Suspense> : <KnowledgeLibrary world={world} demoMode={demoMode} state={state} />}
    </div>
  </section>
}
