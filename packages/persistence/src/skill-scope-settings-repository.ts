import type { DatabaseSync } from 'node:sqlite'
import type { SkillScopeSettings, SkillSettingsScope } from '@dsh-cyber/contracts'

interface SkillScopeSettingsRow {
  workspace_id: string
  scope: SkillSettingsScope
  scope_id: string
  skill_ids_json: string
  updated_at: string
}

export class SkillScopeSettingsRepository {
  constructor(private readonly database: DatabaseSync) {}

  get(workspaceId: string, scope: SkillSettingsScope, scopeId: string): SkillScopeSettings | undefined {
    const row = this.database.prepare(`
      SELECT workspace_id, scope, scope_id, skill_ids_json, updated_at
      FROM skill_scope_settings
      WHERE workspace_id = ? AND scope = ? AND scope_id = ?
    `).get(workspaceId, scope, scopeId) as SkillScopeSettingsRow | undefined
    return row === undefined ? undefined : mapRow(row)
  }

  list(workspaceId: string): SkillScopeSettings[] {
    return (this.database.prepare(`
      SELECT workspace_id, scope, scope_id, skill_ids_json, updated_at
      FROM skill_scope_settings
      WHERE workspace_id = ?
      ORDER BY scope, scope_id
    `).all(workspaceId) as unknown as SkillScopeSettingsRow[]).map(mapRow)
  }

  save(input: { workspaceId: string; scope: SkillSettingsScope; scopeId: string; skillIds: readonly string[]; now?: Date }): SkillScopeSettings {
    const skillIds = normalizeSkillIds(input.skillIds)
    const updatedAt = (input.now ?? new Date()).toISOString()
    this.database.prepare(`
      INSERT INTO skill_scope_settings (workspace_id, scope, scope_id, world_id, skill_ids_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, scope, scope_id) DO UPDATE SET
        skill_ids_json = excluded.skill_ids_json,
        updated_at = excluded.updated_at
    `).run(input.workspaceId, input.scope, input.scopeId, input.scope === 'world' ? input.scopeId : null, JSON.stringify(skillIds), updatedAt)
    return { workspaceId: input.workspaceId, scope: input.scope, scopeId: input.scopeId, skillIds, updatedAt }
  }

  clear(workspaceId: string, scope: SkillSettingsScope, scopeId: string): boolean {
    return this.database.prepare(`
      DELETE FROM skill_scope_settings
      WHERE workspace_id = ? AND scope = ? AND scope_id = ?
    `).run(workspaceId, scope, scopeId).changes > 0
  }
}

function mapRow(row: SkillScopeSettingsRow): SkillScopeSettings {
  const parsed: unknown = JSON.parse(row.skill_ids_json)
  return {
    workspaceId: row.workspace_id,
    scope: row.scope,
    scopeId: row.scope_id,
    skillIds: normalizeSkillIds(Array.isArray(parsed) ? parsed : []),
    updatedAt: row.updated_at,
  }
}

function normalizeSkillIds(values: readonly unknown[]): string[] {
  const result = values.map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean)
  if (new Set(result).size !== result.length) throw new Error('Skill scope settings contain duplicate ids')
  return result.sort((left, right) => left.localeCompare(right))
}
