import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  SqliteStore,
  WorldKnowledgeGraphRepository,
  WorldKnowledgeRepository,
} from '@dsh-cyber/persistence'

import { WorldKnowledgeEvidenceInvalidationService } from '../src/services/world-knowledge-evidence-invalidation-service.js'

const stores: SqliteStore[] = []
const hash = (seed: string): string => seed.repeat(64).slice(0, 64)

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

async function database(): Promise<SqliteStore> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-cyber-invalidation-'))
  const store = await SqliteStore.open(join(directory, 'cyber.sqlite'))
  stores.push(store)
  return store
}

function service(store: SqliteStore, repository: WorldKnowledgeGraphRepository, maxVersionsPerRun: number) {
  return new WorldKnowledgeEvidenceInvalidationService({
    repository: {
      listWorlds: () => store.listWorkspaces().flatMap((workspace) =>
        store.listWorlds(workspace.id).map((world) => ({ workspaceId: workspace.id, worldId: world.id }))),
      retireRemovedKnowledgeSources: (worldId, limit) => repository.retireRemovedKnowledgeSources(worldId, limit),
      reinstateCurrentKnowledgeSourceVersions: (worldId) => repository.reinstateCurrentKnowledgeSourceVersions(worldId),
      listPendingKnowledgeSourceInvalidations: (worldId, limit) => repository.listPendingKnowledgeSourceInvalidations(worldId, limit),
      invalidateKnowledgeSourceVersion: (input) => repository.invalidateKnowledgeSourceVersion(input),
    },
    maxVersionsPerRun,
  })
}

/** One document, chunked, extracted into one claim, then edited to new content. */
async function supersededDocument(input: {
  library: WorldKnowledgeRepository
  repository: WorldKnowledgeGraphRepository
  workspaceId: string
  worldId: string
  index: number
}): Promise<{ documentId: string; claimId: string; evidenceId: string }> {
  const { library, repository, workspaceId, worldId, index } = input
  const document = library.saveDocument({
    workspaceId, worldId, relativePath: `notes/source-${index}.md`, title: `资料 ${index}`,
    mimeType: 'text/markdown', byteLength: 8, sha256: hash(String(index)), origin: 'upload',
  })
  library.replaceChunks(worldId, document.id, [{ ordinal: 0, content: `第一版内容 ${index}`, contentHash: hash(String(index)) }])
  repository.beginKnowledgeSourceVersion({
    workspaceId, worldId, sourceType: 'document', sourceId: document.id, contentHash: hash(String(index)), chunkTotal: 1,
  })
  const evidence = repository.createEvidence({
    workspaceId, worldId, sourceType: 'document', documentId: document.id,
    chunkId: library.listChunks(worldId, document.id)[0]!.id, excerpt: `第一版内容 ${index}`,
  })
  const subject = repository.upsertEntity({ workspaceId, worldId, type: 'topic', canonicalName: `主题 ${index}` })
  const claim = repository.upsertClaim({
    workspaceId, worldId, type: 'fact', subjectEntityId: subject.id,
    predicate: `断言 ${index}`, objectText: `第一版内容 ${index}`, evidenceIds: [evidence.id],
  })
  library.saveDocument({
    workspaceId, worldId, relativePath: `notes/source-${index}.md`, title: `资料 ${index}`,
    mimeType: 'text/markdown', byteLength: 9, sha256: hash(`${index}x`), origin: 'upload',
  })
  library.replaceChunks(worldId, document.id, [{ ordinal: 0, content: `第二版内容 ${index}`, contentHash: hash(`${index}x`) }])
  repository.beginKnowledgeSourceVersion({
    workspaceId, worldId, sourceType: 'document', sourceId: document.id, contentHash: hash(`${index}x`), chunkTotal: 1,
  })
  return { documentId: document.id, claimId: claim.id, evidenceId: evidence.id }
}

describe('WorldKnowledgeEvidenceInvalidationService', () => {
  it('downgrades a bounded batch per run, resumes where it stopped, and then changes nothing', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '失效批次' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '批次世界', templateId: 'cyber-company' })
    const library = new WorldKnowledgeRepository(store.database)
    const repository = new WorldKnowledgeGraphRepository(store.database)
    const sources = []
    for (let index = 0; index < 3; index += 1) {
      sources.push(await supersededDocument({ library, repository, workspaceId: workspace.id, worldId: world.id, index }))
    }
    const pass = service(store, repository, 2)

    expect(await pass.runOnce()).toMatchObject({ versions: 2, claims: 2 })
    expect(repository.listClaims(world.id).filter((claim) => claim.notCurrent !== undefined)).toHaveLength(2)
    // Resumable: a second run picks up exactly the version the bound left behind.
    expect(await pass.runOnce()).toMatchObject({ versions: 1, claims: 1 })
    expect(repository.listClaims(world.id).filter((claim) => claim.notCurrent !== undefined)).toHaveLength(3)

    // Idempotent: nothing is left to do and no row moves.
    const before = repository.listClaims(world.id, { includeArchived: true })
    expect(await pass.runOnce()).toMatchObject({ versions: 0, claims: 0, relations: 0 })
    expect(repository.listClaims(world.id, { includeArchived: true })).toEqual(before)
    for (const source of sources) expect(repository.getEvidence(world.id, source.evidenceId)).toBeDefined()
  })

  it('retires a deleted source in the same pass and never removes what it downgraded', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '删除来源' })
    const world = store.createWorld({ workspaceId: workspace.id, name: '删除世界', templateId: 'cyber-company' })
    const library = new WorldKnowledgeRepository(store.database)
    const repository = new WorldKnowledgeGraphRepository(store.database)
    const document = library.saveDocument({
      workspaceId: workspace.id, worldId: world.id, relativePath: 'notes/gone.md', title: '会被删除',
      mimeType: 'text/markdown', byteLength: 8, sha256: hash('a'), origin: 'upload',
    })
    library.replaceChunks(world.id, document.id, [{ ordinal: 0, content: '被删除的内容', contentHash: hash('a') }])
    repository.beginKnowledgeSourceVersion({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', sourceId: document.id,
      contentHash: hash('a'), chunkTotal: 1,
    })
    const evidence = repository.createEvidence({
      workspaceId: workspace.id, worldId: world.id, sourceType: 'document', documentId: document.id,
      chunkId: library.listChunks(world.id, document.id)[0]!.id, excerpt: '被删除的内容',
    })
    const subject = repository.upsertEntity({ workspaceId: workspace.id, worldId: world.id, type: 'topic', canonicalName: '删除主题' })
    const claim = repository.upsertClaim({
      workspaceId: workspace.id, worldId: world.id, type: 'fact', subjectEntityId: subject.id,
      predicate: '来自被删除资料', objectText: '被删除的内容', evidenceIds: [evidence.id],
    })
    const pass = service(store, repository, 10)
    expect(await pass.runOnce(world.id)).toMatchObject({ versions: 0, claims: 0 })

    library.deleteDocument(world.id, document.id)
    expect(await pass.runOnce(world.id)).toMatchObject({ retired: 1, versions: 1, claims: 1 })
    expect(repository.getClaim(world.id, claim.id)).toMatchObject({
      notCurrent: { sourceType: 'document', sourceId: document.id, contentHash: hash('a') },
    })
    // The owner's organised knowledge survives the deletion of its source.
    expect(repository.getClaim(world.id, claim.id)?.objectText).toBe('被删除的内容')
    expect(repository.getEvidence(world.id, evidence.id)).toMatchObject({ excerpt: '被删除的内容' })
    expect(repository.searchClaims(world.id, '来自被删除资料', 10)).toEqual([])
    expect(await pass.runOnce(world.id)).toMatchObject({ retired: 0, versions: 0, claims: 0 })
  })

  it('keeps a downgrade inside the world whose source changed', async () => {
    const store = await database()
    const workspace = store.createWorkspace({ name: '多世界' })
    const first = store.createWorld({ workspaceId: workspace.id, name: '世界甲', templateId: 'cyber-company' })
    const second = store.createWorld({ workspaceId: workspace.id, name: '世界乙', templateId: 'tavern' })
    const library = new WorldKnowledgeRepository(store.database)
    const repository = new WorldKnowledgeGraphRepository(store.database)
    const alpha = await supersededDocument({ library, repository, workspaceId: workspace.id, worldId: first.id, index: 0 })
    const beta = await supersededDocument({ library, repository, workspaceId: workspace.id, worldId: second.id, index: 1 })
    const pass = service(store, repository, 10)

    expect(await pass.runOnce(first.id)).toMatchObject({ worlds: 1, versions: 1, claims: 1 })
    expect(repository.getClaim(first.id, alpha.claimId)?.notCurrent).toBeDefined()
    expect(repository.getClaim(second.id, beta.claimId)?.notCurrent).toBeUndefined()
    expect(await pass.runOnce()).toMatchObject({ versions: 1, claims: 1 })
    expect(repository.getClaim(second.id, beta.claimId)?.notCurrent).toBeDefined()
  })
})
