import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SkinImportAnalyzeResult } from '@dsh-cyber/contracts'

import { createCyberServer, type CyberServer } from '../src/index.js'
import { parseSkinManifest, parseSkinPalette } from '../src/skin-manifest.js'
import {
  DEFAULT_SKIN_PALETTE,
  SkinImportAnalyzer,
  normalizeSkinDraft,
  normalizeSkinSource,
  parseHexColor,
} from '../src/services/skin-import-analyzer.js'
import { compileSkinPackage } from '../src/services/skin-package-compiler.js'

/**
 * Phase G — Skin Generator, the third generator on the Character Generator's
 * pattern.
 *
 * A generated skin is a skin package: the same declaration-only artifact the
 * official skins are. These tests pin that the skin schema is a closed
 * allowlist (hex colours, a bounded opacity, an official backdrop id), that a
 * model-invented CSS, URL or code value cannot survive analyze, publish or the
 * installer's parser, that the untrusted source never becomes a value, and
 * that the routes publish into the workspace-private catalog and install
 * through the ordinary skin path.
 */

type AnyRecord = Record<string, any>

const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'skin-generator', 'night-library-style.md')
const servers: CyberServer[] = []
const roots: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('skin schema allowlist', () => {
  it('rejects a CSS function, a URL, a colour name and code where a colour is expected', () => {
    for (const hostile of ['url(https://evil.example/a.png)', 'var(--host-secret)', 'rgba(0,0,0,0.5)', 'expression(alert(1))', 'red', '#12345', '#1234567', ' #123456', 'javascript:alert(1)', 'linear-gradient(#000, #fff)', '#ABCDEF']) {
      expect(() => parseSkinPalette({ ...DEFAULT_SKIN_PALETTE, accentColor: hostile }), hostile).toThrow(/#rrggbb/u)
    }
  })

  it('bounds the opacity and refuses unknown palette or manifest fields', () => {
    for (const opacity of [0, 0.1, 1.01, 2, -1, Number.NaN, Number.POSITIVE_INFINITY, '0.9' as unknown as number]) {
      expect(() => parseSkinPalette({ ...DEFAULT_SKIN_PALETTE, backdropOpacity: opacity }), String(opacity)).toThrow(/backdropOpacity/u)
    }
    expect(() => parseSkinPalette({ ...DEFAULT_SKIN_PALETTE, customCss: 'body{}' })).toThrow(/Unknown skin palette field/u)
    expect(() => parseSkinPalette({ ...DEFAULT_SKIN_PALETTE, backdropImage: '/assets/x.png' })).toThrow(/Unknown skin palette field/u)
    const base = { schemaVersion: 1, id: 'generated.skin.a', skinId: 'generated.skin.a', themeId: 'generated.skin.a', displayName: '皮肤', summary: '简介', palette: DEFAULT_SKIN_PALETTE }
    const context = { packageId: 'generated.skin.a', packageVersion: '1.0.0' }
    expect(() => parseSkinManifest({ ...base, stylesheet: 'assets/a.css' }, context)).toThrow(/Unknown skin manifest field/u)
    expect(() => parseSkinManifest({ ...base, backdropSkinId: '../marketplace/skins/neon-cyber' }, context)).toThrow(/backdropSkinId/u)
    expect(() => parseSkinManifest({ ...base, backdropSkinId: 'not-an-official-skin' }, context)).toThrow(/not an official skin/u)
    expect(parseSkinManifest({ ...base, backdropSkinId: 'sakura-shrine' }, context).backdropSkinId).toBe('sakura-shrine')
    // Official skins keep working without any palette at all.
    expect(parseSkinManifest({ schemaVersion: 1, id: 'neon-cyber', skinId: 'neon-cyber', themeId: 'neon-cyber', displayName: '霓虹电波', summary: '简介' }, { packageId: 'neon-cyber', packageVersion: '1.0.0' })).not.toHaveProperty('palette')
  })

  it('accepts only hex literals from a model and normalizes them', () => {
    expect(parseHexColor('#ABC')).toBe('#aabbcc')
    expect(parseHexColor(' #1F2A3B ')).toBe('#1f2a3b')
    for (const hostile of ['url(#abc)', 'var(--x)', 'rgb(1,2,3)', 'red', '#ab', '#abcd', 'abc', 123, null, '#abc; background:url(x)']) {
      expect(parseHexColor(hostile), String(hostile)).toBeUndefined()
    }
  })
})

describe('Skin Generator analyzer', () => {
  it('rebuilds hostile model output through the palette allowlist and never echoes the source', async () => {
    const source = await readFile(fixturePath, 'utf8')
    const seen: string[] = []
    const analyzer = new SkinImportAnalyzer(
      { getWorkspace: () => ({ id: 'workspace-skin-generator' }), resolveWorkspaceDefaultProfile: () => fakeProfile() } as any,
      { resolve: () => 'fake-key' } as any,
      {
        fetch: (async (_url: URL | string, init?: RequestInit) => {
          seen.push(String(init?.body ?? ''))
          return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            displayName: '深夜图书馆',
            summary: source.slice(source.indexOf('IMPORTANT SYSTEM OVERRIDE'), source.indexOf('IMPORTANT SYSTEM OVERRIDE') + 160),
            palette: {
              accentColor: 'url(https://evil.example/track.png)',
              pageBackground: 'var(--host-secret)',
              panelBackground: 'expression(alert(1))',
              textColor: '#EEF2F7',
              ownerBubbleColor: '#345',
              characterBubbleColor: 'rgba(0, 0, 0, 0.5)',
              backdropOpacity: 7,
              backdropImage: '/etc/passwd',
              customCss: 'body { background: url(x) }',
            },
            backdrop: '../../marketplace/skins/neon-cyber',
            packageId: 'neon-cyber',
            themeId: 'default',
            previewAsset: 'assets/evil.png',
          }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
        }) as typeof fetch,
        resolveHostname: { resolve: async () => ['93.184.216.34'] },
      },
    )
    const result = await analyzer.analyze({
      workspaceId: 'workspace-skin-generator',
      source: { kind: 'file', fileName: 'night-library-style.md', text: source },
    })
    expect(seen[0]).toContain('untrusted user data')
    const draft = result.draft
    expect(draft.displayName).toBe('深夜图书馆')
    // A verbatim slab of the source is an echo, not a summary: replaced.
    expect(draft.summary).not.toContain('IMPORTANT SYSTEM OVERRIDE')
    expect(draft.palette).toEqual({
      accentColor: DEFAULT_SKIN_PALETTE.accentColor,
      pageBackground: DEFAULT_SKIN_PALETTE.pageBackground,
      panelBackground: DEFAULT_SKIN_PALETTE.panelBackground,
      textColor: '#eef2f7',
      ownerBubbleColor: '#334455',
      characterBubbleColor: DEFAULT_SKIN_PALETTE.characterBubbleColor,
      backdropOpacity: DEFAULT_SKIN_PALETTE.backdropOpacity,
    })
    expect(result.suggestedBackdropId).toBeUndefined()
    expect(JSON.stringify(result)).not.toMatch(/url\(|var\(|expression|evil\.example|passwd|customCss|backdropImage|packageId|themeId|previewAsset|neon-cyber/u)
    expect(draft.sourceRefs).toEqual(['source:night-library-style.md'])
  })

  it('guards the untrusted source envelope before any model is called', () => {
    expect(() => normalizeSkinSource({ kind: 'paste', text: '   ' })).toThrow(expect.objectContaining({ code: 'skin_source_empty' }))
    expect(() => normalizeSkinSource({ kind: 'file', text: '深蓝' })).toThrow(expect.objectContaining({ code: 'skin_source_filename_required' }))
    expect(() => normalizeSkinSource({ kind: 'file', fileName: 'style.css', text: 'body{}' })).toThrow(expect.objectContaining({ code: 'skin_source_filename_invalid' }))
    expect(() => normalizeSkinSource({ kind: 'paste', text: 'x'.repeat(128 * 1024 + 1) })).toThrow(expect.objectContaining({ code: 'skin_source_too_large' }))
    expect(() => normalizeSkinSource({ kind: 'paste', text: 'a\u0001b' })).toThrow(expect.objectContaining({ code: 'skin_source_control_character' }))
    expect(() => normalizeSkinSource({ kind: 'shell' as any, text: 'rm -rf' })).toThrow(expect.objectContaining({ code: 'skin_source_kind_invalid' }))
  })

  it('rejects tampered colours, opacity, code and source echoes at publish time', async () => {
    const source = await readFile(fixturePath, 'utf8')
    const context = { sourceRef: 'source:file', originalText: source, rejectUnknown: true }
    const draft = validDraft()
    expect(() => normalizeSkinDraft({ ...draft, palette: { ...draft.palette, accentColor: 'url(https://evil.example/a.png)' } }, context)).toThrow(/#rrggbb/u)
    expect(() => normalizeSkinDraft({ ...draft, palette: { ...draft.palette, pageBackground: 'var(--x)' } }, context)).toThrow(/#rrggbb/u)
    expect(() => normalizeSkinDraft({ ...draft, palette: { ...draft.palette, backdropOpacity: 3 } }, context)).toThrow(/透明度/u)
    expect(() => normalizeSkinDraft({ ...draft, summary: 'body { background: url(x) }' }, context)).toThrow(/代码/u)
    expect(() => normalizeSkinDraft({ ...draft, displayName: '<script>alert(1)</script>' }, context)).toThrow(/代码/u)
    // A prose slab (no code tokens in it) is caught by the echo check alone.
    const prose = source.slice(source.indexOf('一间安静的深夜图书馆'), source.indexOf('\n', source.indexOf('一间安静的深夜图书馆')))
    expect(() => normalizeSkinDraft({ ...draft, summary: prose }, context)).toThrow(/原始资料/u)
    // Analyze mode filters instead of rejecting, and extra keys never survive.
    const filtered = normalizeSkinDraft({ ...draft, palette: { ...draft.palette, accentColor: 'red', customCss: 'x' }, packageId: 'neon-cyber' }, { sourceRef: 'source:file', originalText: source })
    expect(filtered.palette.accentColor).toBe(DEFAULT_SKIN_PALETTE.accentColor)
    expect(filtered).not.toHaveProperty('packageId')
    expect(filtered.palette).not.toHaveProperty('customCss')
  })
})

describe('Skin Generator compiler', () => {
  it('produces a package identical in shape to the official skins, gated by the installer parser', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-skin-compiler-'))
    roots.push(root)
    const draft = validDraft()
    const compiled = await compileSkinPackage({
      sourceDirectory: join(root, 'generated.skin.test'),
      packageId: 'generated.skin.test',
      displayName: draft.displayName,
      summary: draft.summary,
      palette: draft.palette,
      backdropSkinId: 'moonlit-tavern',
      createdAt: '2026-09-01T00:00:00.000Z',
    })
    const official = JSON.parse(await readFile(join(process.cwd(), 'marketplace', 'skins', 'neon-cyber', 'dsh-cyber.package.json'), 'utf8')) as AnyRecord
    expect(Object.keys(compiled.manifest).sort()).toEqual(Object.keys(official).filter((key) => key !== 'certification').sort())
    expect(compiled.manifest.kind).toBe('skin')
    expect(compiled.manifest.capabilities).toEqual(['ui:skin'])
    expect(compiled.manifest.dataEgress).toEqual([])
    expect(compiled.manifest.entrypoints).toEqual([{ id: 'generated.skin.test', kind: 'skin', path: 'skin.json' }])
    expect(await readdir(join(root, 'generated.skin.test'))).toEqual(expect.arrayContaining(['dsh-cyber.package.json', 'skin.json']))
    const written = JSON.parse(await readFile(join(root, 'generated.skin.test', 'skin.json'), 'utf8'))
    expect(parseSkinManifest(written, { packageId: 'generated.skin.test', packageVersion: '1.0.0' })).toEqual(compiled.skin)
    expect(written.themeId).toBe('generated.skin.test')
    expect(written.backdropSkinId).toBe('moonlit-tavern')

    // A hostile value never reaches disk: the parser refuses before mkdir.
    await expect(compileSkinPackage({
      sourceDirectory: join(root, 'generated.skin.hostile'),
      packageId: 'generated.skin.hostile',
      displayName: draft.displayName,
      summary: draft.summary,
      palette: { ...draft.palette, accentColor: 'url(x)' },
      createdAt: '2026-09-01T00:00:00.000Z',
    })).rejects.toThrow(/#rrggbb/u)
    await expect(readdir(join(root, 'generated.skin.hostile'))).rejects.toThrow()
  })
})

describe('Skin Generator routes', () => {
  it('analyzes, publishes into the workspace catalog, installs through the skin path and exposes the palette', async () => {
    const server = await startServer()
    const workspace = server.store.listWorkspaces()[0]!
    const source = { kind: 'file' as const, fileName: 'night-library-style.md', text: await readFile(fixturePath, 'utf8') }

    const catalog = await getJson(server.origin, `/api/workspaces/${workspace.id}/skin-generator/catalog`)
    expect(catalog.status).toBe(200)
    expect((catalog.body.catalog.backdrops as AnyRecord[]).map((item) => item.id)).toEqual(expect.arrayContaining(['moonlit-tavern', 'sakura-shrine', 'neon-cyber']))
    expect((catalog.body.catalog.backdrops as AnyRecord[]).every((item) => item.source === 'official')).toBe(true)

    const analyzed = await postJson(server.origin, `/api/workspaces/${workspace.id}/skin-generator/analyze`, { source })
    expect(analyzed.status, JSON.stringify(analyzed.body)).toBe(200)
    // The stub's hostile suggestions are filtered by the route, not trusted.
    expect(analyzed.body.draft.palette.accentColor).toBe('#5aa9e6')
    expect(analyzed.body.draft.palette.panelBackground).toBe(DEFAULT_SKIN_PALETTE.panelBackground)
    expect(analyzed.body.suggestedBackdropId).toBe('moonlit-tavern')
    expect(JSON.stringify(analyzed.body)).not.toMatch(/url\(|evil\.example/u)

    const draft = { ...analyzed.body.draft, displayName: '深夜图书馆 · 测试' }
    const published = await postJson(server.origin, `/api/workspaces/${workspace.id}/skin-generator/publish`, { source, draft, backdrop: { kind: 'official', id: 'sakura-shrine' } })
    expect(published.status, JSON.stringify(published.body)).toBe(201)
    const packageId = published.body.item.manifest.id as string
    expect(packageId).toMatch(/^generated\.skin\./u)
    expect(published.body.item.market).toBe('skin')
    expect(published.body.item.verified).toBe(false)
    expect(published.body.skin.palette.accentColor).toBe('#5aa9e6')
    expect(published.body.skin.backdropSkinId).toBe('sakura-shrine')
    // Publishing installs nothing.
    expect(server.store.listInstalledPackages(workspace.id).some((item) => item.packageId === packageId)).toBe(false)
    // The package lives under the workspace-scoped generated root, skins segment.
    expect(published.body.item.sourceDirectory).toContain(join('workshop', 'character-generator', 'workspaces'))
    expect(published.body.item.sourceDirectory).toContain(`${join('marketplace', 'skins')}${join('/', packageId)}`)
    const original = await readFile(join(published.body.item.sourceDirectory, 'source', 'original.md'), 'utf8')
    expect(original).toBe(source.text)

    const listed = await getJson(server.origin, `/api/marketplace?market=skin&workspaceId=${encodeURIComponent(workspace.id)}`)
    const item = (listed.body.items as AnyRecord[]).find((candidate) => candidate.manifest.id === packageId)
    expect(item?.activation).toEqual({ kind: 'skin', skinId: packageId, skinVersion: '1.0.0', themeId: packageId })

    const preview = await postJson(server.origin, `/api/workspaces/${workspace.id}/marketplace/preview`, { packageId, version: '1.0.0' })
    expect(preview.status).toBe(200)
    const installed = await postJson(server.origin, `/api/workspaces/${workspace.id}/marketplace/install`, { packageId, version: '1.0.0', approvalToken: preview.body.preview.approvalToken })
    expect(installed.status, JSON.stringify(installed.body)).toBe(201)
    expect(installed.body.installed.kind).toBe('skin')
    expect(installed.body.installed.capabilities).toEqual(['ui:skin'])

    const skins = await getJson(server.origin, `/api/workspaces/${workspace.id}/skins`)
    expect(skins.status).toBe(200)
    const declared = (skins.body.items as AnyRecord[]).find((candidate) => candidate.packageId === packageId)
    expect(declared?.manifest.palette).toEqual(published.body.skin.palette)
    expect(declared?.manifest.backdropSkinId).toBe('sakura-shrine')
  })

  it('rejects a tampered colour, an unlisted backdrop and a hostile source at publish', async () => {
    const server = await startServer()
    const workspace = server.store.listWorkspaces()[0]!
    const source = { kind: 'paste' as const, text: '深蓝底色、暖黄阅读灯的安静图书馆。'.repeat(3) }
    const analyzed = await postJson(server.origin, `/api/workspaces/${workspace.id}/skin-generator/analyze`, { source })
    expect(analyzed.status).toBe(200)
    const draft = analyzed.body.draft

    const badColor = await postJson(server.origin, `/api/workspaces/${workspace.id}/skin-generator/publish`, { source, draft: { ...draft, palette: { ...draft.palette, textColor: 'url(https://evil.example/x)' } } })
    expect(badColor.status).toBe(422)
    expect(badColor.body.error.code).toBe('skin_draft_color_invalid')

    const badBackdrop = await postJson(server.origin, `/api/workspaces/${workspace.id}/skin-generator/publish`, { source, draft, backdrop: { kind: 'official', id: '../../etc' } })
    expect(badBackdrop.status).toBe(422)
    expect(badBackdrop.body.error.code).toBe('skin_backdrop_not_allowed')

    const badSource = await postJson(server.origin, `/api/workspaces/${workspace.id}/skin-generator/publish`, { source: { kind: 'file', fileName: 'theme.css', text: 'body{}' }, draft })
    expect(badSource.status).toBe(422)
    expect(badSource.body.error.code).toBe('skin_source_filename_invalid')

    // Nothing was written for any rejected publish.
    const listed = await getJson(server.origin, `/api/marketplace?market=skin&workspaceId=${encodeURIComponent(workspace.id)}`)
    expect((listed.body.items as AnyRecord[]).some((item) => String(item.manifest.id).startsWith('generated.skin.'))).toBe(false)
  })
})

function fakeProfile() {
  return {
    id: 'profile-skin-generator', workspaceId: 'workspace-skin-generator', displayName: 'fake',
    providerKind: 'openai-compatible-remote', baseUrl: 'https://models.example.test/v1', modelId: 'fake',
    api: 'openai-completions', isDefault: true, settings: {}, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }
}

function validDraft() {
  return {
    schemaVersion: 1 as const,
    displayName: '深夜图书馆',
    summary: '深蓝底色配暖黄阅读灯的安静阅读氛围。',
    palette: {
      accentColor: '#5aa9e6',
      pageBackground: '#0b1220',
      panelBackground: '#121c2e',
      textColor: '#eef2f7',
      ownerBubbleColor: '#1f3352',
      characterBubbleColor: '#16233a',
      backdropOpacity: 0.9,
    },
    sourceSummary: '来自用户提供的皮肤描述。',
    sourceRefs: ['source:file'],
  }
}

/** Deterministic stub that also volunteers hostile values the route must filter. */
function staticSkinAnalyzer() {
  return {
    async analyze(): Promise<SkinImportAnalyzeResult> {
      const draft = validDraft()
      return {
        draft: {
          ...draft,
          palette: { ...draft.palette, panelBackground: 'url(https://evil.example/panel.png)' as string },
          ...({ packageId: 'neon-cyber' } as object),
        },
        suggestedBackdropId: 'moonlit-tavern',
      }
    },
  }
}

async function startServer() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skin-generator-'))
  roots.push(root)
  const server = await createCyberServer({
    stateRoot: root,
    workspacePath: root,
    port: 0,
    bootstrapDefaultWorld: true,
    skinImportAnalyzer: staticSkinAnalyzer(),
  } as Parameters<typeof createCyberServer>[0])
  servers.push(server)
  const address = await server.start()
  return Object.assign(server, { origin: address.origin, root })
}

async function postJson(origin: string, path: string, body: unknown): Promise<{ status: number; body: AnyRecord }> {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json().catch(() => ({})) as AnyRecord }
}

async function getJson(origin: string, path: string): Promise<{ status: number; body: AnyRecord }> {
  const response = await fetch(`${origin}${path}`)
  return { status: response.status, body: await response.json().catch(() => ({})) as AnyRecord }
}
