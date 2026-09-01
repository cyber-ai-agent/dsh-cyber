import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  characterGeneratorMarketplaceRoot,
  legacyCharacterGeneratorMarketplaceRoot,
  migrateLegacyCharacterGeneratorMarketplace,
  workspaceDirectorySegment,
} from '../src/services/character-generator-marketplace.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workspaceDirectorySegment', () => {
  it('produces a path-safe segment that cannot traverse', () => {
    for (const workspaceId of ['../../etc', 'a/b', '..', '.', 'C:\\windows', '  spaced  ', '工作区', '\u0000null']) {
      expect(workspaceDirectorySegment(workspaceId)).toMatch(/^[a-z0-9][a-z0-9-]*$/u)
    }
    expect(() => workspaceDirectorySegment('   ')).toThrow()
  })

  it('never collides across ids that differ only by case or punctuation', () => {
    // Case-insensitive filesystems would otherwise merge two workspaces into
    // one directory and reopen the leak this layout closes.
    const ids = ['AB', 'ab', 'a-b', 'a_b', '../../etc', 'a/b']
    const segments = ids.map(workspaceDirectorySegment)
    expect(new Set(segments.map((value) => value.toLowerCase())).size).toBe(ids.length)
  })

  it('keeps the generated root inside its container', () => {
    const root = characterGeneratorMarketplaceRoot('/state', '../../escape')
    expect(root.startsWith('/state/workshop/character-generator/workspaces/')).toBe(true)
    expect(root).not.toContain('..')
  })
})

describe('migrateLegacyCharacterGeneratorMarketplace', () => {
  it('adopts pre-isolation generated packages into one workspace instead of dropping them', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-character-generator-migrate-'))
    roots.push(stateRoot)
    const legacyTalent = join(legacyCharacterGeneratorMarketplaceRoot(stateRoot), 'talent')
    await mkdir(join(legacyTalent, 'generated.character.one'), { recursive: true })
    await writeFile(join(legacyTalent, 'generated.character.one', 'dsh-cyber.package.json'), '{}\n', 'utf8')
    await mkdir(join(legacyTalent, '.generated.character.two.staging-abc'), { recursive: true })

    const moved = await migrateLegacyCharacterGeneratorMarketplace(stateRoot, 'workspace-alpha')
    expect(moved).toEqual(['generated.character.one'])

    const adoptedTalent = join(characterGeneratorMarketplaceRoot(stateRoot, 'workspace-alpha'), 'talent')
    expect(await readdir(adoptedTalent)).toEqual(['generated.character.one'])
    // The legacy root is retired, so nothing keeps reading from a global path.
    await expect(readdir(legacyTalent)).rejects.toThrow()
  })

  it('is idempotent and never overwrites an already adopted package', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-character-generator-migrate-twice-'))
    roots.push(stateRoot)
    const legacyTalent = join(legacyCharacterGeneratorMarketplaceRoot(stateRoot), 'talent')
    await mkdir(join(legacyTalent, 'generated.character.one'), { recursive: true })
    await writeFile(join(legacyTalent, 'generated.character.one', 'marker.txt'), 'legacy\n', 'utf8')
    const adoptedTalent = join(characterGeneratorMarketplaceRoot(stateRoot, 'workspace-alpha'), 'talent')
    await mkdir(join(adoptedTalent, 'generated.character.one'), { recursive: true })
    await writeFile(join(adoptedTalent, 'generated.character.one', 'marker.txt'), 'current\n', 'utf8')

    expect(await migrateLegacyCharacterGeneratorMarketplace(stateRoot, 'workspace-alpha')).toEqual([])
    expect(await migrateLegacyCharacterGeneratorMarketplace(stateRoot, 'workspace-alpha')).toEqual([])
    await expect(readdir(adoptedTalent)).resolves.toEqual(['generated.character.one'])
  })

  it('does nothing when there is no legacy directory', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-character-generator-migrate-empty-'))
    roots.push(stateRoot)
    await expect(migrateLegacyCharacterGeneratorMarketplace(stateRoot, 'workspace-alpha')).resolves.toEqual([])
  })
})
