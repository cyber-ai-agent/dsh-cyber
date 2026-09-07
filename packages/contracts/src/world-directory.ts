/** Public world membership, never a copy of a character's persona or private memory. */
export interface WorldDirectoryMember {
  characterId: string
  displayName: string
  role: string
  characterRevision: number
  grantedSkillIds: string[]
  availableSkillIds: string[]
}

export interface WorldDirectorySnapshot {
  worldId: string
  workspaceId: string
  actorId: string
  revision: string
  availabilityKnown: boolean
  members: WorldDirectoryMember[]
}

export interface WorldDirectoryPage {
  availabilityKnown: boolean
  revision: string
  totalMembers: number
  matchedMembers: number
  items: WorldDirectoryMember[]
  nextOffset?: number
}

export interface WorldDirectoryQuery {
  query?: string
  offset?: number
  limit?: number
  expectedRevision?: string
}

/** Shared deterministic implementation used by the host and actual Harness tools. */
export function queryWorldDirectory(snapshot: WorldDirectorySnapshot, input: WorldDirectoryQuery = {}): WorldDirectoryPage {
  if (input.expectedRevision !== undefined && input.expectedRevision !== snapshot.revision) {
    throw new Error('世界成员名册已更新，请从第一页重新查询。')
  }
  const offset = boundedInteger(input.offset, 0, 0, 1_000_000)
  const limit = boundedInteger(input.limit, 20, 1, 40)
  if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 256)) throw new TypeError('成员检索词不得超过 256 个字符。')
  const query = input.query?.normalize('NFKC').toLocaleLowerCase('zh-CN').trim() ?? ''
  const terms = query.split(/\s+/).filter(Boolean)
  const matches = terms.length === 0 ? snapshot.members : snapshot.members.filter((member) => {
    const text = [member.characterId, member.displayName, member.role, ...member.grantedSkillIds]
      .join(' ').normalize('NFKC').toLocaleLowerCase('zh-CN')
    return terms.every((term) => text.includes(term))
  })
  return {
    revision: snapshot.revision,
    availabilityKnown: snapshot.availabilityKnown,
    totalMembers: snapshot.members.length,
    matchedMembers: matches.length,
    items: matches.slice(offset, offset + limit).map(copyMember),
    ...(offset + limit < matches.length ? { nextOffset: offset + limit } : {}),
  }
}

export function getWorldDirectoryMember(snapshot: WorldDirectorySnapshot, characterId: string): WorldDirectoryMember | undefined {
  const member = snapshot.members.find((entry) => entry.characterId === characterId)
  return member === undefined ? undefined : copyMember(member)
}

function copyMember(member: WorldDirectoryMember): WorldDirectoryMember {
  return { ...member, grantedSkillIds: [...member.grantedSkillIds], availableSkillIds: [...member.availableSkillIds] }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('成员目录分页参数无效。')
  return value
}
