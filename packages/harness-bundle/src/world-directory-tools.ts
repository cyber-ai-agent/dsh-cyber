import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  queryWorldDirectory, getWorldDirectoryMember,
  type WorldDirectorySnapshot, type WorldDirectoryMember,
} from '@dsh-cyber/contracts'

/** Read-only, per-worker snapshot. No network/file permissions and no role dispatch. */
export class WorldDirectoryTools {
  #snapshot: WorldDirectorySnapshot | undefined
  #installed = false

  constructor(private readonly ctx: Context) {}

  update(value: unknown): { revision: string; totalMembers: number } {
    const snapshot = parseSnapshot(value)
    if (this.#snapshot && (snapshot.actorId !== this.#snapshot.actorId || snapshot.worldId !== this.#snapshot.worldId || snapshot.workspaceId !== this.#snapshot.workspaceId)) {
      throw new Error('成员目录不能切换到另一个角色或世界。')
    }
    this.#snapshot = snapshot
    if (!this.#installed) {
      this.#install()
      this.#installed = true
    }
    return { revision: snapshot.revision, totalMembers: snapshot.members.length }
  }

  #current(): WorldDirectorySnapshot {
    if (!this.#snapshot) throw new Error('本轮未提供世界成员名册。')
    return this.#snapshot
  }

  #install(): void {
    const pageParameters = {
      offset: { type: 'integer', description: '从 0 开始的偏移；下一页使用 nextOffset。' },
      limit: { type: 'integer', description: '每页 1–40 人，默认 20。' },
      expectedRevision: { type: 'string', description: '分页时携带上页 revision，防止名册更新后漏人。' },
    } as const
    // Render only our own public DTO. Never allow a model argument to select a
    // different world, a private profile, a memory table or a network address.
    const output = {
      schema: { type: 'json' } as const,
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    }
    const definitions = [
      defineTool({
        name: 'world_directory_list',
        description: '列出本轮开始时当前世界的活动成员及公开职责。分页完整可达；不代表私聊共享或已发起协作。',
        parameters: pageParameters, output,
        isConcurrencySafe: () => true,
        execute: async (args) => JSON.parse(JSON.stringify(queryWorldDirectory(this.#current(), args))),
      }),
      defineTool({
        name: 'world_directory_search',
        description: '在本轮当前世界的完整名册中按姓名、职责或技能检索。重名返回多个稳定 characterId。',
        parameters: { ...pageParameters, query: { type: 'string', required: true, description: '姓名、职责或技能关键词，最多 256 字符。' } }, output,
        isConcurrencySafe: () => true,
        execute: async (args) => JSON.parse(JSON.stringify(queryWorldDirectory(this.#current(), args))),
      }),
      defineTool({
        name: 'world_directory_get',
        description: '按稳定 characterId 查看当前世界成员的公开身份和技能；不读取其 Persona 或私聊。',
        parameters: { characterId: { type: 'string', required: true, description: '名册返回的 characterId，不使用显示名猜测。' } }, output,
        isConcurrencySafe: () => true,
        execute: async ({ characterId }) => {
          const snapshot = this.#current()
          const member = getWorldDirectoryMember(snapshot, characterId)
          return JSON.parse(JSON.stringify({ revision: snapshot.revision, availabilityKnown: snapshot.availabilityKnown, member: member ?? null }))
        },
      }),
    ]
    this.ctx.effect(() => {
      const disposers = definitions.map((definition) => this.ctx.tools.register(definition))
      return () => { for (const dispose of disposers) dispose(); this.#snapshot = undefined }
    }, 'world-directory.tools')
  }
}

/** Validate the host/worker seam and explicitly project fields; private extras never survive. */
function parseSnapshot(value: unknown): WorldDirectorySnapshot {
  const record = object(value)
  if (!Array.isArray(record.members) || record.members.length > 20_000) throw new TypeError('世界成员名册数量无效。')
  const seen = new Set<string>()
  const members: WorldDirectoryMember[] = record.members.map((raw) => {
    const member = object(raw)
    const characterId = text(member.characterId, 160)
    if (seen.has(characterId)) throw new TypeError('成员标识重复。')
    seen.add(characterId)
    if (!Number.isSafeInteger(member.characterRevision) || (member.characterRevision as number) < 0) throw new TypeError('成员版本无效。')
    const grantedSkillIds = strings(member.grantedSkillIds)
    const availableSkillIds = strings(member.availableSkillIds).filter((id) => grantedSkillIds.includes(id))
    return {
      characterId, displayName: text(member.displayName, 160), role: text(member.role, 240, true),
      characterRevision: member.characterRevision as number, grantedSkillIds, availableSkillIds,
    }
  })
  const actorId = text(record.actorId, 160)
  if (!seen.has(actorId)) throw new TypeError('当前角色必须在成员名册中。')
  return {
    worldId: text(record.worldId, 160), workspaceId: text(record.workspaceId, 160), actorId,
    revision: text(record.revision, 160), availabilityKnown: record.availabilityKnown === true, members,
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('成员目录数据无效。')
  return value as Record<string, unknown>
}
function text(value: unknown, limit: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > limit) throw new TypeError('成员目录字段无效。')
  return value
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError('成员技能列表无效。')
  return [...new Set(value.map((item) => text(item, 240)))].sort()
}
