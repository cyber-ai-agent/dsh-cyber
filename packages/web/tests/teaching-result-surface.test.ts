import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { World, WorldArtifactVersion } from '@dsh-cyber/contracts'
import { knowledgeGardenTheme } from '@dsh-cyber/world-runtime'
import { newsCenterTheme } from '@dsh-cyber/world-runtime'

import type { ArtifactRecord } from '../src/features/artifacts/useWorldArtifacts.js'
import { TeachingResultSurface } from '../src/features/world/teaching/TeachingResultSurface.js'
import {
  buildTeachingSurfaceModel,
  classifyTeachingArtifact,
  isVideoResultArtifact,
  parseLessonCards,
  teachingSurfaceVocabulary,
  TEACHING_LANE_ORDER,
} from '../src/features/world/teaching/teaching-result-surface.js'

const world: World = {
  id: 'world-teaching',
  workspaceId: 'workspace-teaching',
  name: '教学世界',
  templateId: 'personal-world',
  status: 'active',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
}

function version(overrides: Partial<WorldArtifactVersion> = {}): WorldArtifactVersion {
  return {
    artifactId: 'artifact-1',
    version: 1,
    relativePath: 'v1/board.md',
    byteLength: 64,
    sha256: 'hash',
    createdAt: '2026-08-28T00:00:00.000Z',
    ...overrides,
  }
}

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'artifact-1',
    workspaceId: world.workspaceId,
    worldId: world.id,
    title: '一次函数板书',
    kind: 'markdown',
    status: 'active',
    currentVersion: 1,
    createdByKind: 'employee',
    createdById: 'employee-1',
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:01:00.000Z',
    currentVersionInfo: version(),
    ...overrides,
  }
}

describe('teaching result classification', () => {
  it('routes worked-through text and documents onto the board', () => {
    expect(classifyTeachingArtifact(artifact())).toBe('blackboard')
    expect(classifyTeachingArtifact(artifact({ kind: 'document', currentVersionInfo: version({ relativePath: 'v1/lecture.pdf', mimeType: 'application/pdf' }) }))).toBe('blackboard')
    expect(classifyTeachingArtifact(artifact({ kind: 'other', currentVersionInfo: version({ relativePath: 'v1/notes.txt' }) }))).toBe('blackboard')
    expect(classifyTeachingArtifact(artifact({ kind: 'image', currentVersionInfo: version({ relativePath: 'v1/board.png', mimeType: 'image/png' }) }))).toBe('blackboard')
  })

  it('routes structured lesson data onto cards and animation onto media', () => {
    expect(classifyTeachingArtifact(artifact({ kind: 'data', currentVersionInfo: version({ relativePath: 'v1/lesson.json', mimeType: 'application/json' }) }))).toBe('lesson-cards')
    expect(classifyTeachingArtifact(artifact({ kind: 'html', currentVersionInfo: version({ relativePath: 'v1/animation.html', mimeType: 'text/html' }) }))).toBe('media')
    expect(classifyTeachingArtifact(artifact({ kind: 'other', currentVersionInfo: version({ relativePath: 'v1/clip.mp4', mimeType: 'video/mp4' }) }))).toBe('media')
    expect(classifyTeachingArtifact(artifact({ kind: 'image', currentVersionInfo: version({ relativePath: 'v1/loop.gif', mimeType: 'image/gif' }) }))).toBe('media')
  })

  it('refuses to present code, archives and projects as a teaching result', () => {
    expect(classifyTeachingArtifact(artifact({ kind: 'code', currentVersionInfo: version({ relativePath: 'v1/main.ts' }) }))).toBeUndefined()
    expect(classifyTeachingArtifact(artifact({ kind: 'archive', currentVersionInfo: version({ relativePath: 'v1/pack.zip' }) }))).toBeUndefined()
    expect(classifyTeachingArtifact(artifact({ kind: 'project', currentVersionInfo: version({ relativePath: 'v1/site' }) }))).toBeUndefined()
  })

  it('knows which media artifacts a video element can actually play', () => {
    expect(isVideoResultArtifact(artifact({ kind: 'other', currentVersionInfo: version({ relativePath: 'v1/clip.webm', mimeType: 'video/webm' }) }))).toBe(true)
    expect(isVideoResultArtifact(artifact({ kind: 'image', currentVersionInfo: version({ relativePath: 'v1/loop.gif', mimeType: 'image/gif' }) }))).toBe(false)
    expect(isVideoResultArtifact(artifact({ kind: 'html' }))).toBe(false)
  })
})

describe('teaching result surface model', () => {
  it('reports an empty world honestly instead of inventing a board', () => {
    const model = buildTeachingSurfaceModel([], teachingSurfaceVocabulary())
    expect(model.lanes.map((lane) => lane.id)).toEqual([...TEACHING_LANE_ORDER])
    expect(model.presentedCount).toBe(0)
    expect(model.hasPresentableResult).toBe(false)
    expect(model.defaultLaneId).toBe('blackboard')
    expect(model.lanes.every((lane) => lane.artifacts.length === 0)).toBe(true)
  })

  it('opens on the lane that actually holds the single result', () => {
    const lesson = artifact({ id: 'lesson-1', kind: 'data', currentVersionInfo: version({ artifactId: 'lesson-1', relativePath: 'v1/lesson.json' }) })
    const model = buildTeachingSurfaceModel([lesson], teachingSurfaceVocabulary())
    expect(model.defaultLaneId).toBe('lesson-cards')
    expect(model.presentedCount).toBe(1)
    expect(model.lanes.find((lane) => lane.id === 'lesson-cards')?.artifacts.map((item) => item.id)).toEqual(['lesson-1'])
  })

  it('groups several kinds, keeps the newest first and counts what it will not present', () => {
    const model = buildTeachingSurfaceModel([
      artifact({ id: 'board-old', updatedAt: '2026-08-28T00:01:00.000Z' }),
      artifact({ id: 'board-new', updatedAt: '2026-08-28T09:00:00.000Z' }),
      artifact({ id: 'lesson-1', kind: 'data' }),
      artifact({ id: 'clip-1', kind: 'other', currentVersionInfo: version({ relativePath: 'v1/clip.mp4', mimeType: 'video/mp4' }) }),
      artifact({ id: 'code-1', kind: 'code', currentVersionInfo: version({ relativePath: 'v1/main.ts' }) }),
      artifact({ id: 'archived-board', status: 'archived' }),
    ], teachingSurfaceVocabulary())
    const lane = (id: string) => model.lanes.find((item) => item.id === id)!
    expect(lane('blackboard').artifacts.map((item) => item.id)).toEqual(['board-new', 'board-old'])
    expect(lane('lesson-cards').artifacts.map((item) => item.id)).toEqual(['lesson-1'])
    expect(lane('media').artifacts.map((item) => item.id)).toEqual(['clip-1'])
    expect(lane('knowledge-graph').live).toBe(true)
    expect(lane('knowledge-graph').artifacts).toEqual([])
    expect(model.presentedCount).toBe(4)
    expect(model.otherCount).toBe(1)
  })
})

describe('theme vocabulary opt-in', () => {
  it('stays generic for a theme that declares nothing', () => {
    const vocabulary = teachingSurfaceVocabulary()
    expect(vocabulary.mode).toBe('generic')
    expect(vocabulary.laneLabels.blackboard).toBe('结果板')
    expect(vocabulary.laneLabels['lesson-cards']).toBe('结果卡片')
  })

  it('becomes teaching vocabulary when the theme declares it in terminology', () => {
    const vocabulary = teachingSurfaceVocabulary({ terminology: { resultSurface: 'teaching' } })
    expect(vocabulary.mode).toBe('teaching')
    expect(vocabulary.surfaceLabel).toBe('教学结果')
    expect(vocabulary.laneLabels.blackboard).toBe('板书')
    expect(vocabulary.laneLabels['lesson-cards']).toBe('课程卡片')
    expect(vocabulary.laneLabels['knowledge-graph']).toBe('知识图')
  })

  it('reads a teaching scenario from the scene the theme already declares', () => {
    const scenes = [{ interactables: [{ kind: 'workstation' }, { kind: 'blackboard' }] }]
    expect(teachingSurfaceVocabulary({ scenes }).mode).toBe('teaching')
    expect(teachingSurfaceVocabulary({ scenes }).laneLabels.blackboard).toBe('板书')
    expect(teachingSurfaceVocabulary({ scenes: [{ interactables: [{ kind: 'workstation' }] }] }).mode).toBe('generic')
    // An explicit terminology declaration still wins over the scene guess.
    expect(teachingSurfaceVocabulary({ terminology: { resultSurface: 'generic' }, scenes }).mode).toBe('generic')
  })

  it('dresses the shipped surface in the News Center vocabulary without a second surface', () => {
    const vocabulary = teachingSurfaceVocabulary(newsCenterTheme)
    expect(vocabulary.mode).toBe('generic')
    expect(vocabulary.surfaceLabel).toBe('情报结果')
    expect(vocabulary.laneLabels.blackboard).toBe('简报板')
    expect(vocabulary.laneLabels['knowledge-graph']).toBe('线索图')
    expect(vocabulary.laneLabels['lesson-cards']).toBe('情报卡片')
    expect(vocabulary.laneLabels.media).toBe('图表 · 影像')
  })

  it('lets a theme rename single lanes and ignores non-string declarations', () => {
    const vocabulary = teachingSurfaceVocabulary({
      terminology: { resultSurface: 'teaching', resultSurfaceLabel: '课堂成果', blackboard: '黑板', lessonCards: 42, resultMedia: '' },
    })
    expect(vocabulary.surfaceLabel).toBe('课堂成果')
    expect(vocabulary.laneLabels.blackboard).toBe('黑板')
    expect(vocabulary.laneLabels['lesson-cards']).toBe('课程卡片')
    expect(vocabulary.laneLabels.media).toBe('动画 · 影像')
  })

  it('lets the shipped knowledge garden theme reuse this surface in its own words', () => {
    const vocabulary = teachingSurfaceVocabulary(knowledgeGardenTheme)
    // The garden declares three teaching-ish scene kinds; its explicit
    // `generic` declaration is what keeps the empty-state copy neutral.
    expect(vocabulary.mode).toBe('generic')
    expect(vocabulary.surfaceLabel).toBe('花园成果')
    expect(vocabulary.laneLabels).toEqual({
      blackboard: '摘录板',
      'knowledge-graph': '知识图谱',
      'lesson-cards': '笔记卡片',
      media: '影像资料',
    })
  })
})

describe('lesson card parsing', () => {
  it('reads a real lesson definition into cards', () => {
    const cards = parseLessonCards(JSON.stringify({
      cards: [
        { title: '第一课 · 一次函数', summary: '从图像认识斜率', points: ['画出 y=kx+b', '解释 k 的意义'] },
        { name: '第二课 · 练习', objectives: ['三道课堂练习'] },
      ],
    }))
    expect(cards?.map((card) => card.title)).toEqual(['第一课 · 一次函数', '第二课 · 练习'])
    expect(cards?.[0]?.summary).toBe('从图像认识斜率')
    expect(cards?.[0]?.points).toEqual(['画出 y=kx+b', '解释 k 的意义'])
    expect(cards?.[1]?.points).toEqual(['三道课堂练习'])
  })

  it('refuses to invent cards from data that is not a lesson', () => {
    expect(parseLessonCards(undefined)).toBeUndefined()
    expect(parseLessonCards('not json')).toBeUndefined()
    expect(parseLessonCards(JSON.stringify({ metrics: { runs: 3 } }))).toBeUndefined()
    expect(parseLessonCards(JSON.stringify({ cards: [{ summary: '没有标题的卡片' }] }))).toBeUndefined()
  })
})

describe('the surface inside the world scene area', () => {
  it('says plainly that there is no result yet', () => {
    const html = renderToStaticMarkup(createElement(TeachingResultSurface, {
      world,
      demoMode: true,
      initialArtifacts: [],
      onClose: () => {},
    }))
    expect(html).toContain('这个世界还没有可展示的结果')
    expect(html).not.toContain('teaching-board__surface')
    expect(html).toContain('结果板')
  })

  it('presents one board result with its own chrome', () => {
    const html = renderToStaticMarkup(createElement(TeachingResultSurface, {
      world,
      demoMode: true,
      initialArtifacts: [artifact()],
      onClose: () => {},
    }))
    expect(html).toContain('一次函数板书')
    expect(html).toContain('teaching-board')
    expect(html).not.toContain('这个世界还没有可展示的结果')
  })

  it('offers every lane and teaching vocabulary when the theme opted in', () => {
    const html = renderToStaticMarkup(createElement(TeachingResultSurface, {
      world,
      demoMode: true,
      vocabulary: teachingSurfaceVocabulary({ terminology: { resultSurface: 'teaching' } }),
      initialArtifacts: [
        artifact(),
        artifact({ id: 'lesson-1', kind: 'data' }),
        artifact({ id: 'clip-1', kind: 'other', currentVersionInfo: version({ relativePath: 'v1/clip.mp4', mimeType: 'video/mp4' }) }),
      ],
      onClose: () => {},
    }))
    expect(html).toContain('板书')
    expect(html).toContain('课程卡片')
    expect(html).toContain('知识图')
    expect(html).toContain('动画 · 影像')
    expect(html).toContain('role="tablist"')
  })
})
