import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { World, WorldArtifactVersion } from '@dsh-cyber/contracts'

import { ArtifactCenter, artifactRefsFromMetadata } from '../src/features/artifacts/ArtifactCenter.js'
import { ArtifactDetail } from '../src/features/artifacts/ArtifactDetail.js'
import { ArtifactPreview } from '../src/features/artifacts/ArtifactPreview.js'
import { normalizeArtifactView, type ArtifactRecord } from '../src/features/artifacts/useWorldArtifacts.js'

const world: World = {
  id: 'world-artifact-test',
  workspaceId: 'workspace-artifact-test',
  name: '产物测试世界',
  templateId: 'personal-world',
  status: 'active',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T00:00:00.000Z',
}

const version: WorldArtifactVersion = {
  artifactId: 'artifact-1',
  version: 2,
  relativePath: 'v2/readme.md',
  sourceRelativePath: 'docs/readme.md',
  mimeType: 'text/markdown',
  byteLength: 128,
  sha256: 'hash',
  sessionId: 'session-1',
  workTurnId: 'turn-1',
  agentRunId: 'run-1',
  createdAt: '2026-08-25T00:00:00.000Z',
}

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'artifact-1',
    workspaceId: world.workspaceId,
    worldId: world.id,
    title: '产品说明',
    kind: 'markdown',
    status: 'active',
    currentVersion: 2,
    createdByKind: 'employee',
    createdById: 'employee-1',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:05:00.000Z',
    currentVersionInfo: version,
    ...overrides,
  }
}

describe('World artifact readers', () => {
  it('renders Markdown as a real GFM reading surface with actions and safe links', () => {
    const html = renderToStaticMarkup(createElement(ArtifactPreview, {
      worldId: world.id,
      artifact: artifact(),
      preview: { content: '# 标题\n\n- 列表项\n\n> 引用\n\n| 名称 | 状态 |\n| --- | --- |\n| 页面 | 已发布 |\n\n[打开文档](https://example.com)' },
    }))
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('查看原文')
    expect(html).toContain('复制')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer"')
  })

  it('uses syntax-aware code, structured JSON, and native media readers', () => {
    const codeHtml = renderToStaticMarkup(createElement(ArtifactPreview, {
      worldId: world.id,
      artifact: artifact({ kind: 'code', title: '示例代码', currentVersionInfo: { ...version, relativePath: 'src/main.ts', mimeType: 'text/typescript' } }),
      preview: { content: 'const answer = 42\n// 说明' },
    }))
    expect(codeHtml).toContain('artifact-code-token--keyword')
    expect(codeHtml).toContain('artifact-code-token--number')
    expect(codeHtml).toContain('artifact-code-token--comment')

    const jsonHtml = renderToStaticMarkup(createElement(ArtifactPreview, {
      worldId: world.id,
      artifact: artifact({ kind: 'data', title: '结构化数据', currentVersionInfo: { ...version, relativePath: 'data.json', mimeType: 'application/json' } }),
      preview: { content: '{"name":"DSH","items":[true,null]}' },
    }))
    expect(jsonHtml).toContain('JSON 结构')
    expect(jsonHtml).toContain('name')
    expect(jsonHtml).toContain('items')
    expect(jsonHtml).toContain('<details')

    const media = renderToStaticMarkup(createElement(ArtifactPreview, {
      worldId: world.id,
      artifact: artifact({ kind: 'image', title: '封面', currentVersionInfo: { ...version, relativePath: 'cover.png', mimeType: 'image/png' } }),
      preview: { src: 'data:image/png;base64,AA==', mimeType: 'image/png' },
    }))
    expect(media).toContain('<img')
    expect(media).toContain('data:image/png')

    const pdf = renderToStaticMarkup(createElement(ArtifactPreview, {
      worldId: world.id,
      artifact: artifact({ kind: 'document', title: '报告', currentVersionInfo: { ...version, relativePath: 'report.pdf', mimeType: 'application/pdf' } }),
      preview: { src: '/api/worlds/world-artifact-test/artifacts/artifact-1/preview?version=2', mimeType: 'application/pdf' },
    }))
    expect(pdf).toContain('artifact-pdf-preview')
    expect(pdf).toContain('报告 PDF 预览')
  })

  it('keeps HTML in a sandbox without same-origin access and supports project trees', () => {
    const html = renderToStaticMarkup(createElement(ArtifactPreview, {
      worldId: world.id,
      artifact: artifact({ kind: 'html', title: '网页', currentVersionInfo: { ...version, relativePath: 'dist/index.html', mimeType: 'text/html' } }),
      preview: { content: '<!doctype html><html><body><script>fetch("/api/system/status")</script><h1>预览</h1></body></html>', mimeType: 'text/html' },
    }))
    expect(html).toContain('sandbox="allow-scripts"')
    expect(html).not.toContain('allow-same-origin')
    expect(html).toContain('网页在隔离沙箱中打开')

    const projectHtml = renderToStaticMarkup(createElement(ArtifactPreview, {
      worldId: world.id,
      artifact: artifact({ kind: 'project', title: '项目', currentVersionInfo: { ...version, relativePath: 'project', mimeType: 'application/json' } }),
      preview: { files: [{ path: 'src/main.ts', kind: 'code', content: 'export const ready = true' }, { path: 'README.md', kind: 'markdown', content: '# 项目' }] },
    }))
    expect(projectHtml).toContain('项目文件')
    expect(projectHtml).toContain('src/main.ts')
    expect(projectHtml).toContain('README.md')
    expect(projectHtml).toContain('artifact-code-token--keyword')
  })
})

describe('Durable artifact UI seams', () => {
  it('only turns durable artifact ids into Chat card references', () => {
    expect(artifactRefsFromMetadata({ artifactRefs: ['artifact-1', { id: 'artifact-2' }, '/tmp/readme.md', null] })).toEqual(['artifact-1', 'artifact-2'])
    expect(artifactRefsFromMetadata({ artifactRefs: 'artifact-1' })).toEqual([])
  })

  it('shows real registry metadata and no fake artifact in the center', () => {
    const html = renderToStaticMarkup(createElement(ArtifactCenter, { world, demoMode: true, initialArtifacts: [artifact()] }))
    expect(html).toContain('产品说明')
    expect(html).toContain('Markdown · v2')
    expect(html).toContain('>Markdown</button>')
    expect(html).toContain('从工作目录发布')
    expect(html).not.toContain('v0.3.0-架构设计')
  })

  it('never renders an unproven attribution as host-verified evidence', () => {
    const proven = renderToStaticMarkup(createElement(ArtifactDetail, {
      worldId: world.id,
      artifact: artifact({ evidence: [{ version: 2, grade: 'host-observed', proven: true, observedAt: '2026-08-25T00:04:00.000Z' }] }),
      onBack: () => undefined,
      onRename: async () => undefined,
      onArchive: async () => undefined,
    }))
    expect(proven).toContain('宿主已核实落盘')
    expect(proven).toContain('artifact-detail__evidence--proven')

    for (const grade of ['unproven-window', 'shared-window', 'manifest-declared', 'unknown'] as const) {
      const html = renderToStaticMarkup(createElement(ArtifactDetail, {
        worldId: world.id,
        artifact: artifact({ evidence: [{ version: 2, grade, proven: false }] }),
        onBack: () => undefined,
        onRename: async () => undefined,
        onArchive: async () => undefined,
      }))
      expect(html, grade).toContain('artifact-detail__evidence--unproven')
      expect(html, grade).not.toContain('宿主已核实落盘')
    }
  })

  it('drops a proven flag that does not come with a host-observed grade', () => {
    const view = normalizeArtifactView({
      artifact: artifact(),
      versions: [version],
      evidence: [{ version: 2, grade: 'unproven-window', proven: true }],
    })
    expect(view?.evidence).toEqual([{ version: 2, grade: 'unproven-window', proven: false }])
  })

  it('explains automatic run registration without implying desktop files are scanned', () => {
    const html = renderToStaticMarkup(createElement(ArtifactCenter, { world, demoMode: true, initialArtifacts: [] }))
    expect(html).toContain('真实新增或修改的文件会自动登记')
    expect(html).toContain('桌面和世界目录外的文件')
    expect(html).not.toContain('临时文件不会自动出现在这里')
  })
})
