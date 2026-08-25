import { ArrowsOut, Books, Crosshair, MagnifyingGlass, Minus, Plus, SpinnerGap, WarningCircle, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from 'react'

import { ApiError, api } from '../../api.js'
import { subscribeWorldLive } from '../../world-live-client.js'
import {
  filterKnowledgeGraph,
  KNOWLEDGE_GRAPH_CLAIM_STATUS_LABELS,
  KNOWLEDGE_GRAPH_ENTITY_LABELS,
  KNOWLEDGE_GRAPH_ENTITY_TYPES,
  KNOWLEDGE_GRAPH_LIMIT,
  KNOWLEDGE_GRAPH_SOURCE_LABELS,
  KNOWLEDGE_GRAPH_SOURCES,
  knowledgeGraphPath,
  layoutKnowledgeGraph,
  normalizeKnowledgeGraph,
  type KnowledgeGraphClaim,
  type KnowledgeGraphEdge,
  type KnowledgeGraphEntityType,
  type KnowledgeGraphEvidence,
  type KnowledgeGraphFilters,
  type KnowledgeGraphNode,
  type KnowledgeGraphPosition,
  type KnowledgeGraphSnapshot,
  type KnowledgeGraphSourceKind,
} from './knowledge-graph.js'

export interface KnowledgeGraphProps {
  worldId: string
  workspaceId?: string
  demoMode?: boolean
  onOpenLibrary(): void
  initialSnapshot?: KnowledgeGraphSnapshot
}

interface GraphViewport {
  scale: number
  offsetX: number
  offsetY: number
}

interface CanvasSize {
  width: number
  height: number
}

interface DragState {
  pointerId: number
  clientX: number
  clientY: number
  moved: boolean
}

const EMPTY_GRAPH: KnowledgeGraphSnapshot = { worldId: '', nodes: [], edges: [], claims: [], relations: [], evidence: [] }
const MAX_ACCESSIBLE_NODE_OPTIONS = 80
const MIN_SCALE = 0.32
const MAX_SCALE = 2.8

const DEMO_EVIDENCE: KnowledgeGraphEvidence[] = [
  { id: 'demo:evidence:brief', sourceType: 'document', documentId: 'demo:document:brief', chunkId: 'demo:chunk:3', sourceWeight: 0.9, excerpt: '当前世界的关键协作由角色、计划和可追溯资料共同维持。' },
  { id: 'demo:evidence:map', sourceType: 'artifact', artifactId: 'demo:artifact:graph', artifactVersion: 1, sourceWeight: 0.8, excerpt: '世界实体之间的关系需要保留来源和可回溯证据。' },
]

const DEMO_GRAPH: KnowledgeGraphSnapshot = {
  worldId: 'demo-world',
  generatedAt: '2026-08-26T00:00:00.000Z',
  nodes: [
    demoNode('demo:world', '当前世界', 'concept', '这个世界的设定、角色与资料共同组成长期参考。', ['demo:evidence:brief']),
    demoNode('demo:brief', '团队协作简报', 'artifact', '来自知识库的协作背景资料。', ['demo:evidence:brief']),
    demoNode('demo:character', '核心角色', 'person', '负责在世界中执行任务并积累可验证的工作记录。', ['demo:evidence:brief']),
    demoNode('demo:plan', '季度计划', 'event', '围绕当前世界目标推进的一组计划节点。', ['demo:evidence:brief']),
    demoNode('demo:archive', '证据归档', 'organization', '保存来源、片段定位和关系解释的资料集合。', ['demo:evidence:map']),
    demoNode('demo:source', '公开资料', 'place', '从网页或本地文件导入的可追溯来源。', ['demo:evidence:map']),
  ],
  claims: [],
  relations: [],
  evidence: DEMO_EVIDENCE,
  edges: [
    demoEdge('demo:world', 'demo:brief', '参考'),
    demoEdge('demo:world', 'demo:character', '包含角色'),
    demoEdge('demo:world', 'demo:plan', '推动'),
    demoEdge('demo:brief', 'demo:archive', '归档于'),
    demoEdge('demo:archive', 'demo:source', '追溯至'),
    demoEdge('demo:character', 'demo:plan', '参与'),
  ],
}

export function KnowledgeGraph({ worldId, workspaceId, demoMode = false, onOpenLibrary, initialSnapshot }: KnowledgeGraphProps) {
  const graphRootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<DragState | undefined>(undefined)
  const requestGeneration = useRef(0)
  const viewportRef = useRef<GraphViewport>({ scale: 1, offsetX: 0, offsetY: 0 })
  const [snapshot, setSnapshot] = useState<KnowledgeGraphSnapshot>(initialSnapshot ?? EMPTY_GRAPH)
  const [loading, setLoading] = useState(!demoMode && initialSnapshot === undefined)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [entityType, setEntityType] = useState<KnowledgeGraphEntityType | 'all'>('all')
  const [source, setSource] = useState<KnowledgeGraphSourceKind | 'all'>('all')
  const [depth, setDepth] = useState<0 | 1 | 2>(1)
  const [selectedId, setSelectedId] = useState<string>()
  const [hoveredId, setHoveredId] = useState<string>()
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 0, height: 0 })
  const [viewport, setViewport] = useState<GraphViewport>(viewportRef.current)
  const [fullscreen, setFullscreen] = useState(false)
  const [actionError, setActionError] = useState<string>()

  const loadGraph = useCallback(async () => {
    const generation = ++requestGeneration.current
    setError(undefined)
    if (demoMode) {
      setSnapshot(initialSnapshot ?? DEMO_GRAPH)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const response = await api<unknown>(knowledgeGraphPath(worldId, KNOWLEDGE_GRAPH_LIMIT))
      const next = normalizeKnowledgeGraph(response, worldId)
      if (generation !== requestGeneration.current) return
      setSnapshot(next)
      setSelectedId(undefined)
    } catch (cause) {
      if (generation !== requestGeneration.current) return
      setError(toGraphError(cause))
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }, [demoMode, initialSnapshot, worldId])

  useEffect(() => {
    void loadGraph()
  }, [loadGraph])

  useEffect(() => {
    if (demoMode) return undefined
    return subscribeWorldLive(worldId, 'world-knowledge', () => { void loadGraph() })
  }, [demoMode, loadGraph, worldId])

  const positions = useMemo(() => layoutKnowledgeGraph(snapshot.nodes), [snapshot.nodes])
  const filters = useMemo<KnowledgeGraphFilters>(() => ({ query, entityType, source, depth }), [depth, entityType, query, source])
  const visible = useMemo(() => filterKnowledgeGraph(snapshot, filters, selectedId), [filters, selectedId, snapshot])
  const selectedNode = useMemo(() => snapshot.nodes.find((node) => node.id === selectedId), [selectedId, snapshot.nodes])
  const visibleNodeIds = useMemo(() => new Set(visible.nodes.map((node) => node.id)), [visible.nodes])
  const nodeById = useMemo(() => new Map(snapshot.nodes.map((node) => [node.id, node])), [snapshot.nodes])
  const searchMatches = useMemo(() => snapshot.nodes.filter((node) => visible.matchedIds.has(node.id)), [snapshot.nodes, visible.matchedIds])

  const updateViewport = useCallback((update: GraphViewport | ((current: GraphViewport) => GraphViewport)) => {
    setViewport((current) => {
      const next = typeof update === 'function' ? update(current) : update
      viewportRef.current = next
      return next
    })
  }, [])

  const fitToGraph = useCallback((nodes: readonly KnowledgeGraphNode[]) => {
    if (canvasSize.width <= 0 || canvasSize.height <= 0 || nodes.length === 0) return
    const nodePositions = nodes.map((node) => positions.get(node.id)).filter(isDefined)
    if (nodePositions.length === 0) return
    const bounds = graphBounds(nodePositions)
    const padding = 100
    const scale = clamp(Math.min((canvasSize.width - padding * 2) / Math.max(bounds.width, 1), (canvasSize.height - padding * 2) / Math.max(bounds.height, 1)), MIN_SCALE, 1.55)
    updateViewport({
      scale,
      offsetX: canvasSize.width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale,
      offsetY: canvasSize.height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale,
    })
  }, [canvasSize.height, canvasSize.width, positions, updateViewport])

  const focusNode = useCallback((nodeId: string) => {
    setSelectedId(nodeId)
    const position = positions.get(nodeId)
    if (position === undefined || canvasSize.width <= 0 || canvasSize.height <= 0) return
    updateViewport((current) => ({
      ...current,
      offsetX: canvasSize.width / 2 - position.x * current.scale,
      offsetY: canvasSize.height / 2 - position.y * current.scale,
    }))
  }, [canvasSize.height, canvasSize.width, positions, updateViewport])

  useEffect(() => {
    if (canvasSize.width > 0 && canvasSize.height > 0 && visible.nodes.length > 0) fitToGraph(visible.nodes)
  }, [canvasSize.height, canvasSize.width, depth, entityType, fitToGraph, query, snapshot.nodes, snapshot.worldId, source, visible.nodes])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return undefined
    const host = canvas.parentElement ?? canvas
    const updateSize = () => {
      const rect = host.getBoundingClientRect()
      setCanvasSize({ width: Math.max(0, Math.floor(rect.width)), height: Math.max(0, Math.floor(rect.height)) })
    }
    updateSize()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateSize)
    observer?.observe(host)
    return () => observer?.disconnect()
  }, [fullscreen, loading, snapshot.nodes.length])

  useEffect(() => {
    const root = graphRootRef.current
    if (root === null) return undefined
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === root)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null || canvasSize.width <= 0 || canvasSize.height <= 0) return undefined
    const context = canvas.getContext('2d')
    if (context === null) return undefined
    const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.floor(canvasSize.width * devicePixelRatio))
    canvas.height = Math.max(1, Math.floor(canvasSize.height * devicePixelRatio))
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    context.clearRect(0, 0, canvasSize.width, canvasSize.height)
    drawGraph(context, canvasSize, viewport, visible.nodes, visible.edges, visibleNodeIds, positions, selectedId, hoveredId)
    return undefined
  }, [canvasSize, hoveredId, positions, selectedId, visible.edges, visible.nodes, visibleNodeIds, viewport])

  const findNodeAtPointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): string | undefined => {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    const currentViewport = viewportRef.current
    const worldX = (event.clientX - rect.left - currentViewport.offsetX) / currentViewport.scale
    const worldY = (event.clientY - rect.top - currentViewport.offsetY) / currentViewport.scale
    let nearest: { id: string; distance: number } | undefined
    for (const node of visible.nodes) {
      const position = positions.get(node.id)
      if (position === undefined) continue
      const distance = Math.hypot(position.x - worldX, position.y - worldY)
      const hitRadius = 25 / currentViewport.scale
      if (distance <= hitRadius && (nearest === undefined || distance < nearest.distance)) nearest = { id: node.id, distance }
    }
    return nearest?.id
  }, [positions, visible.nodes])

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, moved: false }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (drag?.pointerId === event.pointerId) {
      const deltaX = event.clientX - drag.clientX
      const deltaY = event.clientY - drag.clientY
      if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) drag.moved = true
      drag.clientX = event.clientX
      drag.clientY = event.clientY
      if (drag.moved) updateViewport((current) => ({ ...current, offsetX: current.offsetX + deltaX, offsetY: current.offsetY + deltaY }))
      return
    }
    setHoveredId(findNodeAtPointer(event))
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (drag?.pointerId === event.pointerId) {
      if (!drag.moved) {
        const nodeId = findNodeAtPointer(event)
        if (nodeId !== undefined) focusNode(nodeId)
      }
      dragRef.current = undefined
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const current = viewportRef.current
    const cursorX = event.clientX - rect.left
    const cursorY = event.clientY - rect.top
    const worldX = (cursorX - current.offsetX) / current.scale
    const worldY = (cursorY - current.offsetY) / current.scale
    const nextScale = clamp(current.scale * Math.exp(-event.deltaY * 0.0012), MIN_SCALE, MAX_SCALE)
    updateViewport({ scale: nextScale, offsetX: cursorX - worldX * nextScale, offsetY: cursorY - worldY * nextScale })
  }

  const zoom = (factor: number) => {
    const current = viewportRef.current
    const centerX = canvasSize.width / 2
    const centerY = canvasSize.height / 2
    const worldX = (centerX - current.offsetX) / current.scale
    const worldY = (centerY - current.offsetY) / current.scale
    const nextScale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE)
    updateViewport({ scale: nextScale, offsetX: centerX - worldX * nextScale, offsetY: centerY - worldY * nextScale })
  }

  const focusFirstMatch = () => {
    const first = searchMatches[0]
    if (first !== undefined) focusNode(first.id)
  }

  const toggleFullscreen = async () => {
    const root = graphRootRef.current
    if (root === null) return
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen()
      else await root.requestFullscreen()
    } catch {
      setActionError('当前浏览器不支持全屏显示，请使用浏览器窗口放大查看。')
    }
  }

  const handleCanvasKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(1.18) }
    if (event.key === '-' || event.key === '_') { event.preventDefault(); zoom(0.84) }
    if (event.key === '0') { event.preventDefault(); fitToGraph(visible.nodes) }
    if (event.key === 'Enter' && hoveredId !== undefined) { event.preventDefault(); focusNode(hoveredId) }
  }

  if (loading) return <GraphLoading />
  if (error !== undefined) return <GraphError message={error} onRetry={() => void loadGraph()} />
  if (snapshot.nodes.length === 0) return <GraphEmpty worldId={worldId} {...(workspaceId === undefined ? {} : { workspaceId })} demoMode={demoMode} onOpenLibrary={onOpenLibrary} onConsolidated={loadGraph} />

  return <section ref={graphRootRef} className={`knowledge-graph knowledge-graph--ready${fullscreen ? ' knowledge-graph--fullscreen' : ''}`} aria-label="知识图谱">
    <header className="knowledge-graph__header">
      <div>
        <span className="knowledge-eyebrow"><Crosshair size={15} aria-hidden="true" />实体关系</span>
        <h3>知识图谱</h3>
        <p>对话、资料与产物会在后台整理为有证据的长期知识。{snapshot.nodes.length}{snapshot.truncated ? '+' : ''} 个实体 · {snapshot.edges.length} 条关系</p>
      </div>
      <div className="knowledge-graph__header-actions">
        <button type="button" className="knowledge-icon-button" onClick={() => fitToGraph(visible.nodes)} aria-label="适配全部节点" title="适配全部节点"><Crosshair size={17} aria-hidden="true" /></button>
        <button type="button" className="knowledge-icon-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? '退出全屏' : '全屏显示'} title={fullscreen ? '退出全屏' : '全屏显示'}><ArrowsOut size={17} aria-hidden="true" /></button>
      </div>
    </header>

    <KnowledgeGraphSettings key={worldId} worldId={worldId} {...(workspaceId === undefined ? {} : { workspaceId })} demoMode={demoMode} onConsolidated={loadGraph} />

    <div className="knowledge-graph__filters" aria-label="图谱筛选">
      <label className="knowledge-graph__search"><MagnifyingGlass size={16} aria-hidden="true" /><span className="knowledge-visually-hidden">搜索实体</span><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); focusFirstMatch() } }} placeholder="搜索实体名称或摘要" type="search" /><button type="button" onClick={() => setQuery('')} disabled={query.length === 0} aria-label="清除实体搜索" title="清除搜索"><X size={15} aria-hidden="true" /></button></label>
      <label className="knowledge-graph__select"><span>实体类型</span><select value={entityType} onChange={(event) => setEntityType(event.target.value as KnowledgeGraphEntityType | 'all')}><option value="all">全部类型</option>{KNOWLEDGE_GRAPH_ENTITY_TYPES.map((type) => <option key={type} value={type}>{KNOWLEDGE_GRAPH_ENTITY_LABELS[type]}</option>)}</select></label>
      <label className="knowledge-graph__select"><span>来源</span><select value={source} onChange={(event) => setSource(event.target.value as KnowledgeGraphSourceKind | 'all')}><option value="all">全部来源</option>{KNOWLEDGE_GRAPH_SOURCES.map((kind) => <option key={kind} value={kind}>{KNOWLEDGE_GRAPH_SOURCE_LABELS[kind]}</option>)}</select></label>
      <div className="knowledge-graph__depth" role="group" aria-label="关系深度"><span>深度</span>{([0, 1, 2] as const).map((value) => <button key={value} type="button" className={depth === value ? 'is-active' : ''} aria-pressed={depth === value} onClick={() => setDepth(value)}>{value === 0 ? '全部' : `${value} 层`}</button>)}</div>
      <button type="button" className="knowledge-button knowledge-button--quiet" onClick={focusFirstMatch} disabled={searchMatches.length === 0} title="聚焦搜索结果"><Crosshair size={16} aria-hidden="true" />聚焦</button>
    </div>

    {actionError === undefined ? null : <div className="knowledge-notice knowledge-notice--error knowledge-notice--inline" role="alert"><WarningCircle size={16} aria-hidden="true" /><span>{actionError}</span></div>}
    <div className="knowledge-graph__body">
      <div className="knowledge-graph__canvas-panel">
        <div className="knowledge-graph__canvas-toolbar">
          <span>{visible.nodes.length}{visible.nodes.length !== snapshot.nodes.length ? ` / ${snapshot.nodes.length}` : ''} 个可见实体</span>
          <div>
            <button type="button" className="knowledge-icon-button" onClick={() => zoom(0.82)} aria-label="缩小图谱" title="缩小"><Minus size={16} aria-hidden="true" /></button>
            <output aria-label="当前缩放比例">{Math.round(viewport.scale * 100)}%</output>
            <button type="button" className="knowledge-icon-button" onClick={() => zoom(1.22)} aria-label="放大图谱" title="放大"><Plus size={16} aria-hidden="true" /></button>
            <button type="button" className="knowledge-button knowledge-button--quiet" onClick={() => fitToGraph(visible.nodes)}><Crosshair size={15} aria-hidden="true" />适配</button>
          </div>
        </div>
        <div className="knowledge-graph__canvas-wrap">
          <canvas ref={canvasRef} className={`knowledge-graph__canvas${hoveredId !== undefined ? ' is-hovering' : ''}`} tabIndex={0} aria-label={`知识图谱画布，${visible.nodes.length} 个实体，${visible.edges.length} 条关系。可拖动画布、滚轮缩放，按 Enter 聚焦悬停实体。`} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onPointerLeave={() => { if (dragRef.current === undefined) setHoveredId(undefined) }} onWheel={handleWheel} onKeyDown={handleCanvasKeyDown} />
          {visible.nodes.length === 0 ? <div className="knowledge-graph__filtered-empty"><MagnifyingGlass size={22} aria-hidden="true" /><strong>筛选后没有实体</strong><span>换一个搜索词或放宽筛选条件。</span></div> : null}
        </div>
        <div className="knowledge-graph__canvas-help"><span>拖动平移</span><span>滚轮缩放</span><span>点击节点查看详情</span></div>
      </div>
      <aside className="knowledge-graph__details" aria-label="实体详情">
        <label className="knowledge-graph__node-picker"><span>键盘选择实体</span><select value={selectedId ?? ''} onChange={(event) => { const value = event.target.value; if (value) focusNode(value); else setSelectedId(undefined) }}><option value="">选择一个实体</option>{visible.nodes.slice(0, MAX_ACCESSIBLE_NODE_OPTIONS).map((node) => <option key={node.id} value={node.id}>{node.name} · {KNOWLEDGE_GRAPH_ENTITY_LABELS[node.type]}</option>)}</select>{visible.nodes.length > MAX_ACCESSIBLE_NODE_OPTIONS ? <small>仅展示前 {MAX_ACCESSIBLE_NODE_OPTIONS} 个，画布仍保留全部节点。</small> : null}</label>
        {selectedNode === undefined ? <div className="knowledge-graph__details-empty"><Crosshair size={24} aria-hidden="true" /><strong>选择一个实体</strong><span>点击画布节点，或使用上方选择框查看 Claims、Relations 与 Evidence。</span></div> : <KnowledgeNodeDetails node={selectedNode} nodeById={nodeById} onSelectNode={focusNode} onOpenLibrary={onOpenLibrary} />}
      </aside>
    </div>
  </section>
}

function KnowledgeNodeDetails({ node, nodeById, onSelectNode, onOpenLibrary }: { node: KnowledgeGraphNode; nodeById: Map<string, KnowledgeGraphNode>; onSelectNode(nodeId: string): void; onOpenLibrary(): void }) {
  return <div className="knowledge-graph__node-details">
    <header>
      <div className="knowledge-graph__node-heading"><span className={`knowledge-graph__entity-dot knowledge-graph__entity-dot--${node.type}`} aria-hidden="true" /><div><span>{KNOWLEDGE_GRAPH_ENTITY_LABELS[node.type]} · {node.sourceLabel}</span><h3>{node.name}</h3></div></div>
      <p>{node.summary}</p>
    </header>
    <GraphDetailSection title="Claims · 事实主张" count={node.claims.length} empty="尚未提取有来源的事实主张。"><ul className="knowledge-graph__claim-list">{node.claims.map((claim) => <ClaimRow key={claim.id} claim={claim} />)}</ul></GraphDetailSection>
    <GraphDetailSection title="Relations · 关系" count={node.relations.length} empty="暂时没有已确认的关系。"><ul className="knowledge-graph__relation-list">{node.relations.map((relation) => { const target = nodeById.get(relation.targetId); return <li key={relation.id}><button type="button" onClick={() => target === undefined ? undefined : onSelectNode(target.id)} disabled={target === undefined} aria-label={target === undefined ? `关系目标 ${relation.targetId} 尚未加载` : `查看关系目标 ${target.name}`}><span>{relation.label}</span><strong>{target?.name ?? '未加载实体'}</strong></button></li> })}</ul></GraphDetailSection>
    <GraphDetailSection title="Evidence · 证据" count={node.evidence.length} empty="这个实体还没有关联证据。"><ul className="knowledge-graph__evidence-list">{node.evidence.map((evidence) => <EvidenceRow key={evidence.id} evidence={evidence} onOpenLibrary={onOpenLibrary} />)}</ul></GraphDetailSection>
  </div>
}

function GraphDetailSection({ title, count, empty, children }: { title: string; count: number; empty: string; children: ReactNode }) {
  return <section className="knowledge-graph__detail-section"><header><h4>{title}</h4><span>{count}</span></header>{count === 0 ? <p className="knowledge-graph__detail-empty">{empty}</p> : children}</section>
}

function ClaimRow({ claim }: { claim: KnowledgeGraphClaim }) {
  const text = claim.objectText === undefined ? claim.predicate : `${claim.predicate}：${claim.objectText}`
  return <li><span className="knowledge-graph__claim-status">{KNOWLEDGE_GRAPH_CLAIM_STATUS_LABELS[claim.status]}</span><p>{text}</p><small>置信度 {Math.round(claim.confidence * 100)}% · {claim.evidenceIds.length} 条证据</small></li>
}

function EvidenceRow({ evidence, onOpenLibrary }: { evidence: KnowledgeGraphEvidence; onOpenLibrary(): void }) {
  const title = evidence.sourceType === 'document' ? `资料 ${evidence.documentId ?? '未命名'}` : evidence.sourceType === 'conversation' ? `对话消息 ${evidence.messageId ?? '未命名'}` : evidence.sourceType === 'artifact' ? `世界产物 ${evidence.artifactId ?? '未命名'}` : '手动记录'
  const location = evidence.sourceType === 'document' ? [evidence.documentId, evidence.chunkId].filter(isDefined).join(' · ') : evidence.sourceType === 'conversation' ? [evidence.sessionId, evidence.messageId, evidence.sequence === undefined ? undefined : `序列 ${evidence.sequence}`].filter(isDefined).join(' · ') : evidence.sourceType === 'artifact' ? [evidence.artifactId, evidence.artifactVersion === undefined ? undefined : `版本 ${evidence.artifactVersion}`].filter(isDefined).join(' · ') : evidence.note ?? '手动记录'
  return <li><div><strong>{title}</strong><small>{KNOWLEDGE_GRAPH_SOURCE_LABELS[evidence.sourceType]} · {location || '来源定位未提供'}</small></div><button type="button" onClick={onOpenLibrary} title="打开知识库查看证据">查看资料</button>{evidence.excerpt ? <p>{evidence.excerpt}</p> : null}</li>
}

type KnowledgeGraphOrganizationMode = 'off' | 'balanced'

interface KnowledgeGraphModelOption {
  id: string
  name: string
  provider?: string
}

interface KnowledgeGraphSettingsValue {
  retrievalEnabled: boolean
  autoConsolidationMode: KnowledgeGraphOrganizationMode
  extractionModelProfileId: string
  models: KnowledgeGraphModelOption[]
}

function KnowledgeGraphSettings({ worldId, workspaceId, demoMode, onConsolidated }: { worldId: string; workspaceId?: string; demoMode: boolean; onConsolidated(): Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [organizing, setOrganizing] = useState(false)
  const [settings, setSettings] = useState<KnowledgeGraphSettingsValue>({ retrievalEnabled: true, autoConsolidationMode: 'balanced', extractionModelProfileId: 'inherit', models: [] })
  const [error, setError] = useState<string>()
  const loadedRef = useRef(false)

  const loadSettings = useCallback(async () => {
    if (demoMode || loadedRef.current) return
    loadedRef.current = true
    setLoading(true)
    setError(undefined)
    try {
      const response = await api<unknown>(knowledgeGraphSettingsPath(worldId))
      const modelResponse = workspaceId === undefined
        ? undefined
        : await api<unknown>(`/api/workspaces/${encodeURIComponent(workspaceId)}/model-profiles`).catch(() => undefined)
      setSettings(normalizeKnowledgeGraphSettings(response, modelResponse))
    } catch (cause) {
      loadedRef.current = false
      setError(toGraphSettingsError(cause))
    } finally {
      setLoading(false)
    }
  }, [demoMode, workspaceId, worldId])

  const saveSettings = async () => {
    if (demoMode || saving) return
    setSaving(true)
    setError(undefined)
    try {
      const body: Record<string, unknown> = {
        retrievalEnabled: settings.retrievalEnabled,
        autoConsolidationMode: settings.autoConsolidationMode,
      }
      if (settings.extractionModelProfileId !== 'inherit') body.extractionModelProfileId = settings.extractionModelProfileId
      await api(knowledgeGraphSettingsPath(worldId), {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    } catch (cause) {
      setError(toGraphSettingsError(cause))
    } finally {
      setSaving(false)
    }
  }

  const consolidate = async () => {
    if (demoMode || organizing) return
    setOrganizing(true)
    setError(undefined)
    try {
      await api(knowledgeGraphConsolidatePath(worldId), { method: 'POST', body: JSON.stringify({}) })
      await onConsolidated()
    } catch (cause) {
      setError(toGraphSettingsError(cause))
    } finally {
      setOrganizing(false)
    }
  }

  return <details className="knowledge-graph__settings" open={open} onToggle={(event) => { const nextOpen = event.currentTarget.open; setOpen(nextOpen); if (nextOpen) void loadSettings() }}>
    <summary><span><strong>整理设置</strong><small>控制后台知识整理方式，不展开完整运行配置</small></span><span>{settings.autoConsolidationMode === 'off' ? '自动整理已关闭' : '自动整理：平衡'}</span></summary>
    <div className="knowledge-graph__settings-body">
      {demoMode ? <div className="knowledge-notice knowledge-notice--disabled" role="status"><span>演示世界未连接本地知识整理服务，设置入口暂不可用。</span></div> : null}
      {loading ? <div className="knowledge-graph__settings-state" role="status"><SpinnerGap size={17} className="knowledge-spin" aria-hidden="true" />正在读取整理设置…</div> : null}
      {error === undefined ? null : <div className="knowledge-notice knowledge-notice--error" role="alert"><WarningCircle size={16} aria-hidden="true" /><span>{error}</span><button type="button" onClick={() => void loadSettings()}>重试</button></div>}
      <div className="knowledge-graph__settings-grid">
        <label><span>自动整理</span><small>后台只处理有来源的事实与关系</small><select value={settings.autoConsolidationMode} disabled={demoMode || loading || saving} onChange={(event) => setSettings((current) => ({ ...current, autoConsolidationMode: event.target.value as KnowledgeGraphOrganizationMode }))}><option value="off">关闭</option><option value="balanced">平衡</option></select></label>
        <label><span>提取模型</span><small>可继承世界默认模型，或选择已配置模型</small><select value={settings.extractionModelProfileId} disabled={demoMode || loading || saving} onChange={(event) => setSettings((current) => ({ ...current, extractionModelProfileId: event.target.value }))}><option value="inherit">继承世界默认模型</option>{settings.models.map((model) => <option key={model.id} value={model.id}>{model.name}{model.provider ? ` · ${model.provider}` : ''}</option>)}</select></label>
      </div>
      <footer><span>手动整理会读取当前世界的对话、资料与产物，并保留证据定位。</span><div><button type="button" className="knowledge-button" onClick={() => void saveSettings()} disabled={demoMode || loading || saving || organizing}>{saving ? '正在保存…' : '保存设置'}</button><button type="button" className="knowledge-button knowledge-button--primary" onClick={() => void consolidate()} disabled={demoMode || loading || saving || organizing}>{organizing ? '正在整理…' : '开始整理'}</button></div></footer>
    </div>
  </details>
}

function knowledgeGraphSettingsPath(worldId: string): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/knowledge/settings`
}

function knowledgeGraphConsolidatePath(worldId: string): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/knowledge/consolidate`
}

function normalizeKnowledgeGraphSettings(value: unknown, modelResponse?: unknown): KnowledgeGraphSettingsValue {
  const root = isRecord(value) && isRecord(value.settings) ? value.settings : value
  const candidate = isRecord(root) ? root : {}
  const mode = candidate.autoConsolidationMode === 'off' || candidate.autoConsolidationMode === 'balanced' ? candidate.autoConsolidationMode : 'balanced'
  const modelsValue = isRecord(modelResponse) && Array.isArray(modelResponse.items)
    ? modelResponse.items
    : isRecord(value) && Array.isArray(value.modelProfiles)
      ? value.modelProfiles
      : isRecord(value) && Array.isArray(value.models)
        ? value.models
        : Array.isArray(candidate.modelProfiles) ? candidate.modelProfiles : []
  const models = modelsValue.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string') return []
    return [{ id: item.id, name: typeof item.name === 'string' ? item.name : typeof item.displayName === 'string' ? item.displayName : item.id, ...(typeof item.provider === 'string' ? { provider: item.provider } : typeof item.providerKind === 'string' ? { provider: item.providerKind } : {}) }]
  })
  return {
    retrievalEnabled: typeof candidate.retrievalEnabled === 'boolean' ? candidate.retrievalEnabled : true,
    autoConsolidationMode: mode,
    extractionModelProfileId: typeof candidate.extractionModelProfileId === 'string' ? candidate.extractionModelProfileId : 'inherit',
    models,
  }
}

function toGraphSettingsError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404) return '当前服务还没有启用知识整理设置。'
  if (cause instanceof Error && /[\u3400-\u9fff]/u.test(cause.message) && !cause.message.startsWith('Request failed:')) return cause.message
  return '整理设置暂时无法读取或保存，请稍后重试。'
}

function GraphLoading() {
  return <section className="knowledge-graph knowledge-graph--state" aria-label="知识图谱加载中" aria-busy="true"><div className="knowledge-state"><SpinnerGap size={23} className="knowledge-spin" aria-hidden="true" /><strong>正在加载知识图谱…</strong><span>实体与关系会按当前世界范围读取。</span></div></section>
}

function GraphError({ message, onRetry }: { message: string; onRetry(): void }) {
  return <section className="knowledge-graph knowledge-graph--state" aria-label="知识图谱加载失败"><div className="knowledge-state knowledge-state--error"><WarningCircle size={24} aria-hidden="true" /><strong>知识图谱暂时无法读取</strong><span>{message}</span><button type="button" className="knowledge-button knowledge-button--primary" onClick={onRetry}>重试</button></div></section>
}

function GraphEmpty({ worldId, workspaceId, demoMode, onOpenLibrary, onConsolidated }: { worldId: string; workspaceId?: string; demoMode: boolean; onOpenLibrary(): void; onConsolidated(): Promise<void> }) {
  return <section className="knowledge-graph knowledge-graph--state knowledge-graph--empty-state" aria-label="知识图谱空状态"><div className="knowledge-state"><span className="knowledge-graph__mark" aria-hidden="true"><Crosshair size={25} /></span><strong>知识图谱还没有实体</strong><span>先导入并索引资料，整理出有来源的实体、Claims 和 Relations 后，图谱会在这里呈现。</span><button type="button" className="knowledge-button knowledge-button--primary" onClick={onOpenLibrary}><Books size={17} aria-hidden="true" />前往知识库</button></div><KnowledgeGraphSettings key={worldId} worldId={worldId} {...(workspaceId === undefined ? {} : { workspaceId })} demoMode={demoMode} onConsolidated={onConsolidated} /></section>
}

function drawGraph(context: CanvasRenderingContext2D, size: CanvasSize, viewport: GraphViewport, nodes: readonly KnowledgeGraphNode[], edges: readonly KnowledgeGraphEdge[], visibleIds: Set<string>, positions: Map<string, KnowledgeGraphPosition>, selectedId: string | undefined, hoveredId: string | undefined) {
  const styles = getComputedStyle(context.canvas)
  const accent = styles.getPropertyValue('--accent').trim() || '#e0a72f'
  const accentStrong = styles.getPropertyValue('--accent-strong').trim() || '#f0b63b'
  const border = styles.getPropertyValue('--border').trim() || '#29333b'
  const muted = styles.getPropertyValue('--text-muted').trim() || '#89949d'
  const text = styles.getPropertyValue('--text').trim() || '#e4e8ea'
  const surface = styles.getPropertyValue('--surface-1').trim() || '#10161b'
  context.save()
  context.fillStyle = surface
  context.fillRect(0, 0, size.width, size.height)
  context.translate(viewport.offsetX, viewport.offsetY)
  context.scale(viewport.scale, viewport.scale)

  for (const edge of edges) {
    const source = positions.get(edge.sourceId)
    const target = positions.get(edge.targetId)
    if (source === undefined || target === undefined) continue
    const highlighted = selectedId !== undefined && (edge.sourceId === selectedId || edge.targetId === selectedId)
    context.beginPath()
    context.moveTo(source.x, source.y)
    context.lineTo(target.x, target.y)
    context.strokeStyle = highlighted ? accentStrong : border
    context.globalAlpha = highlighted ? 0.92 : 0.72
    context.lineWidth = highlighted ? 2.2 : 1.15
    context.stroke()
  }
  context.globalAlpha = 1

  for (const node of nodes) {
    const position = positions.get(node.id)
    if (position === undefined || !visibleIds.has(node.id)) continue
    const selected = node.id === selectedId
    const hovered = node.id === hoveredId
    const radius = selected || hovered ? 23 : 19
    context.beginPath()
    context.arc(position.x, position.y, radius, 0, Math.PI * 2)
    context.fillStyle = entityColor(node.type, accent)
    context.globalAlpha = selected ? 1 : 0.9
    context.fill()
    context.lineWidth = selected ? 3 : 1.2
    context.strokeStyle = selected ? accentStrong : border
    context.stroke()
    context.globalAlpha = 1
    const label = truncateCanvasLabel(node.name, 18)
    context.font = '600 12px IBM Plex Sans, Noto Sans SC, Microsoft YaHei UI, sans-serif'
    const labelWidth = context.measureText(label).width + 14
    context.fillStyle = surface
    roundRect(context, position.x - labelWidth / 2, position.y + radius + 7, labelWidth, 23, 5)
    context.fill()
    context.strokeStyle = selected ? accent : border
    context.lineWidth = selected ? 1.5 : 0.7
    context.stroke()
    context.fillStyle = text
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(label, position.x, position.y + radius + 18.5)
  }
  context.restore()
  context.fillStyle = muted
  context.font = '12px IBM Plex Sans, Noto Sans SC, Microsoft YaHei UI, sans-serif'
  context.textAlign = 'left'
  context.textBaseline = 'top'
  context.fillText('Canvas 概览 · 点击节点查看详情', 12, 12)
}

function graphBounds(positions: readonly KnowledgeGraphPosition[]): { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number } {
  const minX = Math.min(...positions.map((position) => position.x)) - 24
  const maxX = Math.max(...positions.map((position) => position.x)) + 24
  const minY = Math.min(...positions.map((position) => position.y)) - 24
  const maxY = Math.max(...positions.map((position) => position.y)) + 50
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY }
}

function entityColor(type: KnowledgeGraphEntityType, accent: string): string {
  const colors: Record<KnowledgeGraphEntityType, string> = {
    character: '#6e9fc1',
    person: '#6e9fc1',
    place: '#7fa884',
    organization: '#9b87bd',
    project: '#d48b69',
    artifact: '#b3a16b',
    technology: '#6db2ae',
    concept: accent,
    tool: '#7d9dc1',
    process: '#9e9a6d',
    event: '#d48b69',
    topic: '#a986bc',
    object: '#82929d',
    other: '#7f8b93',
  }
  return colors[type]
}

function truncateCanvasLabel(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const safeRadius = Math.min(radius, width / 2, height / 2)
  context.beginPath()
  context.moveTo(x + safeRadius, y)
  context.arcTo(x + width, y, x + width, y + height, safeRadius)
  context.arcTo(x + width, y + height, x, y + height, safeRadius)
  context.arcTo(x, y + height, x, y, safeRadius)
  context.arcTo(x, y, x + width, y, safeRadius)
  context.closePath()
}

function toGraphError(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404) return '当前服务还没有启用知识图谱，资料仍可在知识库中管理。'
  if (cause instanceof Error && /[\u3400-\u9fff]/u.test(cause.message) && !cause.message.startsWith('Request failed:')) return cause.message
  return '实体关系暂时无法读取，请稍后重试。'
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function demoNode(id: string, name: string, type: KnowledgeGraphEntityType, summary: string, evidenceIds: string[]): KnowledgeGraphNode {
  const source: KnowledgeGraphSourceKind = type === 'artifact' ? 'artifact' : 'manual'
  return {
    id,
    name,
    type,
    source,
    sourceLabel: KNOWLEDGE_GRAPH_SOURCE_LABELS[source],
    summary,
    claims: [{ id: `${id}:claim`, type: 'fact', subjectEntityId: id, predicate: '摘要', objectText: summary, confidence: 0.86, status: 'active', source: 'manual', evidenceIds }],
    relations: [],
    evidence: evidenceIds.flatMap((evidenceId) => DEMO_EVIDENCE.filter((evidence) => evidence.id === evidenceId)),
  }
}

function demoEdge(sourceId: string, targetId: string, label: string): KnowledgeGraphEdge {
  return { id: `${sourceId}:${targetId}`, sourceId, targetId, label, confidence: 0.86, status: 'active', evidenceIds: ['demo:evidence:brief'] }
}
