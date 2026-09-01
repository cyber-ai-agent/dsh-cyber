import { Cards, Chalkboard, FilmSlate, Graph, Package, SpinnerGap, X } from '@phosphor-icons/react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { World } from '@dsh-cyber/contracts'

import { formatDateTime } from '../../../i18n/format.js'
import { ArtifactPreview } from '../../artifacts/ArtifactPreview.js'
import {
  artifactKindLabel,
  artifactPreviewUrl,
  fetchArtifactPreview,
  useWorldArtifacts,
  type ArtifactRecord,
} from '../../artifacts/useWorldArtifacts.js'
import '../../knowledge/knowledge.css'
import {
  buildTeachingSurfaceModel,
  isVideoResultArtifact,
  parseLessonCards,
  teachingSurfaceVocabulary,
  type TeachingLaneId,
  type TeachingResultLane,
  type TeachingSurfaceVocabulary,
} from './teaching-result-surface.js'
import './teaching-result-surface.css'

const KnowledgeGraph = lazy(async () => ({ default: (await import('../../knowledge/KnowledgeGraph.js')).KnowledgeGraph }))

export interface TeachingResultSurfaceProps {
  world: World
  demoMode?: boolean
  /** Supplied by the active Theme; defaults to the neutral world-result vocabulary. */
  vocabulary?: TeachingSurfaceVocabulary
  initialArtifacts?: ArtifactRecord[]
  onClose(): void
  onOpenDockTab?(tab: 'knowledge' | 'artifacts'): void
}

const LANE_ICONS: Record<TeachingLaneId, typeof Chalkboard> = {
  blackboard: Chalkboard,
  'knowledge-graph': Graph,
  'lesson-cards': Cards,
  media: FilmSlate,
}

export function TeachingResultSurface({ world, demoMode = false, vocabulary, initialArtifacts = [], onClose, onOpenDockTab }: TeachingResultSurfaceProps) {
  const rootRef = useRef<HTMLElement>(null)
  const vocabularyValue = useMemo(() => vocabulary ?? teachingSurfaceVocabulary(), [vocabulary])
  const { artifacts, loading, error, reload } = useWorldArtifacts({ worldId: world.id, enabled: !demoMode, initialArtifacts })
  const model = useMemo(() => buildTeachingSurfaceModel(artifacts, vocabularyValue), [artifacts, vocabularyValue])
  const [requestedLaneId, setRequestedLaneId] = useState<TeachingLaneId>()
  const activeLaneId = requestedLaneId ?? model.defaultLaneId
  const activeLane = model.lanes.find((lane) => lane.id === activeLaneId) ?? model.lanes[0]!

  useEffect(() => { rootRef.current?.focus() }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    onClose()
  }

  return <section
    ref={rootRef}
    className="teaching-surface"
    tabIndex={-1}
    aria-label={`${world.name} - ${vocabularyValue.surfaceLabel}展示区`}
    onKeyDown={onKeyDown}
  >
    <header className="teaching-surface__header">
      <div className="teaching-surface__identity">
        <span className="teaching-surface__kicker">{world.name}</span>
        <h2>{vocabularyValue.surfaceLabel}</h2>
        <p>只展示这个世界已经产生的结果：已登记的产物和已有证据的知识图。</p>
      </div>
      <button type="button" className="teaching-surface__close" aria-label={`关闭${vocabularyValue.surfaceLabel}`} onClick={onClose}><X size={17} /></button>
    </header>

    <nav className="teaching-surface__lanes" role="tablist" aria-label={`${vocabularyValue.surfaceLabel}分区`}>
      {model.lanes.map((lane) => {
        const Icon = LANE_ICONS[lane.id]
        return <button
          key={lane.id}
          type="button"
          role="tab"
          id={`teaching-lane-${lane.id}`}
          aria-controls={`teaching-panel-${lane.id}`}
          aria-selected={lane.id === activeLaneId}
          className={lane.id === activeLaneId ? 'is-active' : ''}
          onClick={() => setRequestedLaneId(lane.id)}
        >
          <Icon size={16} aria-hidden="true" />
          <span>{lane.label}</span>
          <small>{lane.live ? '实时' : lane.artifacts.length}</small>
        </button>
      })}
    </nav>

    <div
      className="teaching-surface__panel"
      role="tabpanel"
      id={`teaching-panel-${activeLane.id}`}
      aria-labelledby={`teaching-lane-${activeLane.id}`}
      tabIndex={0}
    >
      {error !== undefined ? <div className="teaching-surface__state teaching-surface__state--error" role="alert">
        <strong>结果列表暂时不可用</strong>
        <span>{error}</span>
        <button type="button" className="teaching-surface__action" onClick={() => void reload()}>重试</button>
      </div> : loading ? <div className="teaching-surface__state" role="status">
        <SpinnerGap size={20} className="spin" aria-hidden="true" />
        <span>正在读取这个世界的结果…</span>
      </div> : <LanePanel
        world={world}
        demoMode={demoMode}
        lane={activeLane}
        vocabulary={vocabularyValue}
        {...(onOpenDockTab === undefined ? {} : { onOpenDockTab })}
      />}
    </div>

    <footer className="teaching-surface__footer">
      <span>{model.hasPresentableResult ? `${model.presentedCount} 项结果可展示` : '尚无可展示结果'}{model.otherCount > 0 ? ` · 另有 ${model.otherCount} 个产物不适合在场景中展示` : ''}</span>
      {onOpenDockTab === undefined ? null : <button type="button" className="teaching-surface__action" onClick={() => onOpenDockTab('artifacts')}><Package size={15} aria-hidden="true" />打开产物中心</button>}
    </footer>
  </section>
}

interface LanePanelProps {
  world: World
  demoMode: boolean
  lane: TeachingResultLane
  vocabulary: TeachingSurfaceVocabulary
  onOpenDockTab?(tab: 'knowledge' | 'artifacts'): void
}

function LanePanel({ world, demoMode, lane, vocabulary, onOpenDockTab }: LanePanelProps) {
  if (lane.id === 'knowledge-graph') {
    return <div className="teaching-lane teaching-lane--graph">
      <Suspense fallback={<div className="teaching-surface__state" role="status"><SpinnerGap size={20} className="spin" aria-hidden="true" /><span>正在载入知识图…</span></div>}>
        <KnowledgeGraph
          worldId={world.id}
          workspaceId={world.workspaceId}
          demoMode={demoMode}
          onOpenLibrary={() => onOpenDockTab?.('knowledge')}
        />
      </Suspense>
    </div>
  }
  if (lane.artifacts.length === 0) {
    return <LaneEmpty lane={lane} vocabulary={vocabulary} {...(onOpenDockTab === undefined ? {} : { onOpenDockTab })} />
  }
  if (lane.id === 'lesson-cards') return <LessonLane worldId={world.id} demoMode={demoMode} lane={lane} />
  if (lane.id === 'media') return <MediaLane worldId={world.id} lane={lane} />
  return <BoardLane worldId={world.id} lane={lane} />
}

function BoardLane({ worldId, lane }: { worldId: string; lane: TeachingResultLane }) {
  const [selectedId, setSelectedId] = useState<string>()
  const selected = lane.artifacts.find((artifact) => artifact.id === selectedId) ?? lane.artifacts[0]!
  return <div className="teaching-lane teaching-lane--board">
    <ResultRail lane={lane} selectedId={selected.id} onSelect={setSelectedId} />
    <article className="teaching-board" aria-label={`${lane.label}：${selected.title}`}>
      <header className="teaching-board__header">
        <h3>{selected.title}</h3>
        <span>{resultMeta(selected)}</span>
      </header>
      <div className="teaching-board__surface">
        <ArtifactPreview worldId={worldId} artifact={selected} {...(selected.preview === undefined ? {} : { preview: selected.preview })} />
      </div>
      <p className="teaching-board__chalk-rail">这块板上的内容来自角色登记的产物，原文可在产物中心追溯版本。</p>
    </article>
  </div>
}

function LessonLane({ worldId, demoMode, lane }: { worldId: string; demoMode: boolean; lane: TeachingResultLane }) {
  const [selectedId, setSelectedId] = useState<string>()
  const selected = lane.artifacts.find((artifact) => artifact.id === selectedId) ?? lane.artifacts[0]!
  const [content, setContent] = useState<string | undefined>(selected.preview?.content)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    const inline = selected.preview?.content
    setContent(inline)
    setUnavailable(false)
    if (inline !== undefined || demoMode) return
    let active = true
    void fetchArtifactPreview(worldId, selected, selected.currentVersion)
      .then((preview) => { if (active) setContent(preview.content) })
      .catch(() => { if (active) setUnavailable(true) })
    return () => { active = false }
  }, [demoMode, selected, worldId])

  const cards = parseLessonCards(content)
  return <div className="teaching-lane teaching-lane--lesson">
    <ResultRail lane={lane} selectedId={selected.id} onSelect={setSelectedId} />
    <div className="teaching-lesson">
      <header className="teaching-lesson__header"><h3>{selected.title}</h3><span>{resultMeta(selected)}</span></header>
      {cards === undefined ? <div className="teaching-lesson__fallback">
        <p className="teaching-lesson__note">{unavailable ? '这份数据产物暂时读不出内容，下面是产物中心的原始视图。' : '这份数据产物没有按课程卡片的结构书写，下面按原样展示。'}</p>
        <ArtifactPreview worldId={worldId} artifact={selected} {...(selected.preview === undefined ? {} : { preview: selected.preview })} />
      </div> : <ul className="teaching-lesson__cards">
        {cards.map((card, index) => <li key={`${card.title}-${index}`}>
          <article className="teaching-card">
            <h4>{card.title}</h4>
            {card.summary === undefined ? null : <p>{card.summary}</p>}
            {card.points.length === 0 ? null : <ul>{card.points.map((point, pointIndex) => <li key={`${point}-${pointIndex}`}>{point}</li>)}</ul>}
          </article>
        </li>)}
      </ul>}
    </div>
  </div>
}

function MediaLane({ worldId, lane }: { worldId: string; lane: TeachingResultLane }) {
  const [selectedId, setSelectedId] = useState<string>()
  const selected = lane.artifacts.find((artifact) => artifact.id === selectedId) ?? lane.artifacts[0]!
  return <div className="teaching-lane teaching-lane--media">
    <ResultRail lane={lane} selectedId={selected.id} onSelect={setSelectedId} />
    <article className="teaching-media" aria-label={`${lane.label}：${selected.title}`}>
      <header className="teaching-media__header"><h3>{selected.title}</h3><span>{resultMeta(selected)}</span></header>
      <div className="teaching-media__stage">
        {isVideoResultArtifact(selected)
          ? <video
              className="teaching-media__video"
              controls
              preload="metadata"
              src={artifactPreviewUrl(worldId, selected.id, selected.currentVersion)}
              aria-label={`${selected.title} 影像产物`}
            />
          : <ArtifactPreview worldId={worldId} artifact={selected} {...(selected.preview === undefined ? {} : { preview: selected.preview })} />}
      </div>
    </article>
  </div>
}

function ResultRail({ lane, selectedId, onSelect }: { lane: TeachingResultLane; selectedId: string; onSelect(artifactId: string): void }) {
  if (lane.artifacts.length < 2) return null
  return <ul className="teaching-rail" aria-label={`${lane.label}列表`}>
    {lane.artifacts.map((artifact) => <li key={artifact.id}>
      <button
        type="button"
        className={artifact.id === selectedId ? 'is-active' : ''}
        aria-current={artifact.id === selectedId}
        onClick={() => onSelect(artifact.id)}
      >
        <strong>{artifact.title}</strong>
        <small>{resultMeta(artifact)}</small>
      </button>
    </li>)}
  </ul>
}

function LaneEmpty({ lane, vocabulary, onOpenDockTab }: { lane: TeachingResultLane; vocabulary: TeachingSurfaceVocabulary; onOpenDockTab?(tab: 'knowledge' | 'artifacts'): void }) {
  const Icon = LANE_ICONS[lane.id]
  return <div className="teaching-surface__state teaching-surface__state--empty">
    <Icon size={26} aria-hidden="true" />
    <strong>这个世界还没有可展示的结果</strong>
    <p>{emptyHint(lane, vocabulary)}</p>
    {onOpenDockTab === undefined ? null : <button type="button" className="teaching-surface__action" onClick={() => onOpenDockTab('artifacts')}><Package size={15} aria-hidden="true" />打开产物中心</button>}
  </div>
}

function emptyHint(lane: TeachingResultLane, vocabulary: TeachingSurfaceVocabulary): string {
  const teaching = vocabulary.mode === 'teaching'
  if (lane.id === 'lesson-cards') {
    return teaching
      ? '角色把课程写成结构化数据产物（cards / lessons）并登记后，这里会出现课程卡片。'
      : '角色登记结构化数据产物后，这里会出现结果卡片。'
  }
  if (lane.id === 'media') {
    return '角色登记网页动画、GIF 或视频产物后，这里可以直接播放，不会替它生成任何内容。'
  }
  return teaching
    ? '角色把讲解写成 Markdown、文档或板书图片并登记为产物后，会出现在这块板上。'
    : '角色登记 Markdown、文档或图片产物后，会出现在这块板上。'
}

function resultMeta(artifact: ArtifactRecord): string {
  return `${artifactKindLabel(artifact.kind)} · v${artifact.currentVersion} · ${formatUpdatedAt(artifact.updatedAt)}`
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : formatDateTime(date, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
