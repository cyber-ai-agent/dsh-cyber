import type { JsonObject } from '@dsh-cyber/contracts'
import type { WorldCharacterPermission } from '@dsh-cyber/contracts/world-authority'

export interface WorldManagementCharacterRef {
  id: string
  displayName: string
  status?: string
}

export interface WorldManagementPlan {
  proposals: WorldManagementIntentProposal[]
  /** Clauses of a compound request that matched no supported action. */
  unhandled: string[]
}

export interface WorldManagementIntentContext {
  worldId: string
  characters: readonly WorldManagementCharacterRef[]
}

/** What a permission utterance asks the authority layer to do. */
export type WorldAuthorityOperation = 'promote' | 'demote' | 'grant' | 'revoke'

export type WorldManagementProposalKind =
  | 'clarification'
  | 'read-authority'
  | 'settings-patch'
  | 'world-rename'
  | 'authority-update'
  | 'character-update'
  | 'package-update'
  | 'model-assign'

export interface WorldManagementIntentProposal {
  kind: WorldManagementProposalKind
  skillId: string
  action: string
  target: string
  label: string
  requiredWorldPermission: WorldCharacterPermission
  parameters: JsonObject
  /** Position within a compound request; 1 for a single-action prompt. */
  ordinal?: number
}

/** Connectors a compound management request may legitimately be split on. */
const CLAUSE_SEPARATORS = /[，,。;；]|然后|接着|再把|并且|同时/u

/**
 * Deliberately small, deterministic V1 parser. It consumes only the raw user
 * prompt and returns no proposal for questions, negation, ambiguous names or
 * vague permission language. It is not an LLM and is never fed transform,
 * package, tool, or agent output.
 */
export class WorldManagementIntentParser {
  /**
   * Compiles a management request into an ordered plan.
   *
   * A compound sentence is split on its connectors first, and each clause is
   * matched on its own. Without that split every value regex ended at `$` and
   * the first one to match swallowed the rest of the sentence — "把当前场景改成
   * 产品评审，然后把老王设成管理员" set the scenario to the whole string and the
   * promotion never happened.
   *
   * Splitting is conservative: only the listed connectors, and a clause that
   * matches nothing is reported rather than silently dropped.
   */
  parse(prompt: string, context: WorldManagementIntentContext, source: 'raw-user' | 'external' = 'raw-user'): WorldManagementIntentProposal[] {
    return this.compile(prompt, context, source).proposals
  }

  compile(
    prompt: string,
    context: WorldManagementIntentContext,
    source: 'raw-user' | 'external' = 'raw-user',
  ): WorldManagementPlan {
    if (source !== 'raw-user') return { proposals: [], unhandled: [] }
    const text = cleanPrompt(prompt)
    if (text === '') return { proposals: [], unhandled: [] }

    const segments = splitClauses(text)
    const proposals: WorldManagementIntentProposal[] = []
    const unhandled: string[] = []
    let lastCharacter: WorldManagementCharacterRef | undefined
    for (const segment of segments) {
      // "把老王设成管理员，给他世界设置权限" keeps talking about 老王. Carrying
      // the previous clause's character across a pronoun is what makes
      // splitting safe; without it the second clause resolves nobody.
      const clauseContext = carriesPronoun(segment) && lastCharacter !== undefined
        ? { ...context, characters: [lastCharacter] }
        : context
      const resolvedHere = resolveCharacter(segment, context.characters).character
      if (resolvedHere !== undefined) lastCharacter = resolvedHere
      const matched = this.#parseClause(carriesPronoun(segment) && lastCharacter !== undefined
        ? segment.replace(/他|她|它|TA|ta/u, lastCharacter.displayName)
        : segment, clauseContext)
      if (matched.length === 0) {
        // Only worth reporting when the sentence was actually compound: a
        // single clause that matches nothing is an ordinary chat message.
        if (segments.length > 1) unhandled.push(segment)
        continue
      }
      for (const proposal of matched) {
        const existing = proposals.find((item) => item.action === proposal.action && item.target === proposal.target)
        if (existing === undefined) {
          proposals.push({ ...proposal, ordinal: proposals.length + 1 })
          continue
        }
        // Two clauses about the same character's authority are one decision,
        // not two: "设成管理员" then "给他这些权限" merges into one promotion.
        if (proposal.action === 'world.authority.update') mergeAuthorityProposal(existing, proposal)
      }
    }
    return { proposals, unhandled }
  }

  #parseClause(text: string, context: WorldManagementIntentContext): WorldManagementIntentProposal[] {
    const target = resolveCharacter(text, context.characters)
    // Ambiguity is scoped to the character branch: two names appearing in a
    // sentence used to veto world-scoped actions that merely mentioned them.
    if (target.ambiguous && mentionsCharacterAction(text)) {
      return [this.clarification(context.worldId, target.candidates)]
    }
    // A narrowly-scoped authority query is safe even when written as a
    // question. It must be answered from the authority store, never guessed
    // by the model. All other questions remain non-mutating no-ops.
    if (target.character !== undefined && /是不是管理员|是否管理员|是管理员吗/u.test(text)
      && !/设成|设置|设为|提升|权限|改成|启用|停用/u.test(text)) {
      return [this.authorityRead(target.character.id, target.character.displayName)]
    }
    if (isQuestion(text) || isExplicitNegation(text)) return []

    const scenario = capture(text, /把(?:当前)?场景改成\s*[「“"']?(.+?)[」”"']?$/u)
    if (scenario !== undefined) return [this.settingsPatch(context.worldId, 'scenario', scenario, '修改当前场景')]
    const lore = capture(text, /把(?:这个)?世界观改成\s*[「“"']?(.+?)[」”"']?$/u)
    if (lore !== undefined) return [this.settingsPatch(context.worldId, 'lore', lore, '修改世界观')]
    const addressAs = capture(text, /以后叫我\s*[「“"']?(.+?)[」”"']?$/u)
    if (addressAs !== undefined) return [this.settingsPatch(context.worldId, 'addressAs', addressAs, '修改称呼')]
    const rename = capture(text, /把(?:这个)?世界改名为\s*[「“"']?(.+?)[」”"']?$/u)
    if (rename !== undefined) return [{
      kind: 'world-rename', skillId: 'builtin.world.rename', action: 'world.rename',
      target: `world:${context.worldId}`, label: '重命名当前世界', requiredWorldPermission: 'world.settings.write',
      parameters: { name: rename },
    }]

    if (target.character !== undefined) {
      const employeeId = target.character.id
      const displayName = target.character.displayName
      if (/设成管理员|设置成管理员|设为管理员|提升为管理员/u.test(text)) {
        const permission = parsePermissionMutation(text)
        return [this.authority(
          context.worldId,
          employeeId,
          displayName,
          'promote',
          permission?.grants ?? [],
          permission === undefined ? '将角色设为世界管理员' : '将角色设为管理员并更新组合权限',
          permission?.remove ?? [],
        )]
      }
      if (/取消.*管理员|撤销.*管理员|降为普通角色|取消.*管理身份/u.test(text)) {
        return [this.authority(context.worldId, employeeId, displayName, 'demote', [], '取消角色的世界管理员身份')]
      }
      const permission = parsePermissionMutation(text)
      if (permission !== undefined) {
        // A permission edit says nothing about the role. Emitting `member`
        // here is what demoted administrators and erased every grant the user
        // did not happen to mention.
        const operation = permission.grants.length > 0 ? 'grant' : 'revoke'
        return [this.authority(context.worldId, employeeId, displayName, operation, permission.grants, permission.label, permission.remove)]
      }
      const identity = capture(text, new RegExp(`把${escapeRegExp(displayName)}的身份改成\\s*[「“"']?(.+?)[」”"']?$`, 'u'))
      if (identity !== undefined) {
        return [{
          kind: 'character-update', skillId: 'builtin.world.characters.update', action: 'world.characters.update',
          target: `character:${employeeId}`, label: `修改${displayName}的身份`, requiredWorldPermission: 'world.characters.manage',
          parameters: { employeeId, role: identity },
        }]
      }
    }

    const enablePackage = capture(text, /(?:给当前世界)?启用\s*[「“"']?(.+?)[」”"']?(?:插件)?$/u)
    if (enablePackage !== undefined && /插件/u.test(text)) return [this.package(context.worldId, enablePackage, true)]
    const disablePackage = capture(text, /停用\s*[「“"']?(.+?)[」”"']?(?:插件)?$/u)
    if (disablePackage !== undefined && /插件/u.test(text)) return [this.package(context.worldId, disablePackage, false)]
    const model = capture(text, /把当前世界默认模型改成\s*[「“"']?(.+?)[」”"']?$/u)
    if (model !== undefined) return [{
      kind: 'model-assign', skillId: 'builtin.world.model.assign', action: 'world.model.assign',
      target: `world:${context.worldId}`, label: '修改当前世界默认模型', requiredWorldPermission: 'world.model.assign',
      parameters: { modelProfileId: model },
    }]
    return []
  }

  private clarification(worldId: string, candidates: readonly WorldManagementCharacterRef[]): WorldManagementIntentProposal {
    return {
      kind: 'clarification',
      skillId: 'builtin.world.characters.list',
      action: 'world.characters.list',
      target: `world:${worldId}`,
      label: '需要确认目标角色',
      requiredWorldPermission: 'world.characters.read',
      parameters: {
        reason: 'ambiguous-character',
        candidates: candidates.map((item) => ({ id: item.id, displayName: item.displayName })),
      },
    }
  }

  private settingsPatch(worldId: string, field: 'scenario' | 'lore' | 'addressAs', value: string, label: string): WorldManagementIntentProposal {
    const parameters: JsonObject = field === 'addressAs'
      ? { userIdentity: { addressAs: value } }
      : { [field]: value }
    return {
      kind: 'settings-patch', skillId: 'builtin.world.settings.update', action: 'world.settings.update',
      target: `world:${worldId}`, label, requiredWorldPermission: 'world.settings.write', parameters,
    }
  }

  private authority(
    worldId: string,
    employeeId: string,
    displayName: string,
    operation: WorldAuthorityOperation,
    grants: WorldCharacterPermission[],
    label: string,
    remove: WorldCharacterPermission[] = [],
  ): WorldManagementIntentProposal {
    return {
      kind: 'authority-update', skillId: 'builtin.world.authority.update', action: 'world.authority.update',
      target: `character:${employeeId}`, label, requiredWorldPermission: 'world.permissions.manage',
      parameters: { employeeId, displayName, operation, permissionGrants: grants, removePermissions: remove },
    }
  }

  private authorityRead(employeeId: string, displayName: string): WorldManagementIntentProposal {
    return {
      kind: 'read-authority', skillId: 'builtin.world.authority.read', action: 'world.authority.read',
      target: `character:${employeeId}`, label: `查看${displayName}的世界权限`, requiredWorldPermission: 'world.permissions.read',
      parameters: { employeeId },
    }
  }

  private package(worldId: string, packageId: string, enabled: boolean): WorldManagementIntentProposal {
    return {
      kind: 'package-update',
      skillId: enabled ? 'builtin.world.packages.instantiate' : 'builtin.world.packages.disable',
      action: enabled ? 'world.packages.instantiate' : 'world.packages.disable',
      target: `world:${worldId}`, label: enabled ? '启用当前世界插件' : '停用当前世界插件',
      requiredWorldPermission: 'world.packages.manage', parameters: { packageId },
    }
  }
}

function parsePermissionMutation(text: string): { grants: WorldCharacterPermission[]; remove: WorldCharacterPermission[]; label: string } | undefined {
  const remove = /取消|撤销|删除|移除/u.test(text)
  if (/高级权限|全部权限|所有权限|完全权限/u.test(text)) return undefined
  const found = new Set<WorldCharacterPermission>()
  if (/世界设置/u.test(text)) found.add('world.settings.write')
  if (/角色管理/u.test(text)) found.add('world.characters.manage')
  if (/文件读写|读写文件/u.test(text)) {
    found.add('world.files.read')
    found.add('world.files.write')
  } else {
    if (/文件写入|写文件/u.test(text)) found.add('world.files.write')
    if (/读取文件|读文件/u.test(text)) found.add('world.files.read')
  }
  if (found.size === 0) return undefined
  const permissions = [...found]
  return {
    grants: remove ? [] : permissions,
    remove: remove ? permissions : [],
    label: remove
      ? (permissions.length === 1 ? '撤销世界权限' : '撤销组合世界权限')
      : (permissions.length === 1 ? '新增世界权限' : '新增组合世界权限'),
  }
}

/**
 * Resolves a character by exact id, then by display name.
 *
 * Names are matched case-insensitively and the longest match wins, so a world
 * holding both 王 and 老王 resolves "把老王设成管理员" to 老王 instead of
 * refusing on a false ambiguity.
 */
function resolveCharacter(
  text: string,
  characters: readonly WorldManagementCharacterRef[],
): { character?: WorldManagementCharacterRef; ambiguous: boolean; candidates: WorldManagementCharacterRef[] } {
  const active = characters.filter((item) => item.status !== 'archived' && item.displayName.length > 0)
  const byId = active.find((item) => item.id.length > 0 && text.includes(item.id))
  if (byId !== undefined) return { character: byId, ambiguous: false, candidates: [byId] }
  const folded = text.toLocaleLowerCase()
  const matches = active.filter((item) => folded.includes(item.displayName.toLocaleLowerCase()))
  if (matches.length === 0) return { ambiguous: false, candidates: [] }
  const longest = Math.max(...matches.map((item) => item.displayName.length))
  const best = [...new Map(matches
    .filter((item) => item.displayName.length === longest)
    .map((item) => [item.id, item])).values()]
  const only = best[0]
  return best.length === 1 && only !== undefined
    ? { character: only, ambiguous: false, candidates: best }
    : { ambiguous: true, candidates: best }
}

/** Whether a clause continues talking about the previous clause's character. */
function carriesPronoun(text: string): boolean {
  return /他|她|它|TA|ta/u.test(text)
}

/** Folds a follow-up authority clause into the decision already proposed. */
function mergeAuthorityProposal(existing: WorldManagementIntentProposal, next: WorldManagementIntentProposal): void {
  const merge = (key: 'permissionGrants' | 'removePermissions'): void => {
    const before = Array.isArray(existing.parameters[key]) ? existing.parameters[key] as string[] : []
    const after = Array.isArray(next.parameters[key]) ? next.parameters[key] as string[] : []
    existing.parameters[key] = [...new Set([...before, ...after])]
  }
  merge('permissionGrants')
  merge('removePermissions')
  // A promotion outranks a plain grant: the user asked for both.
  if (next.parameters.operation === 'promote' || next.parameters.operation === 'demote') {
    existing.parameters.operation = next.parameters.operation
  }
}

/** Splits a compound request on its connectors, keeping non-empty clauses. */
function splitClauses(text: string): string[] {
  const parts = text.split(CLAUSE_SEPARATORS).map((part) => part.trim()).filter((part) => part.length > 0)
  return parts.length === 0 ? [text] : parts
}

/** Whether a clause actually asks for something scoped to a character. */
function mentionsCharacterAction(text: string): boolean {
  return /管理员|权限|身份|岗位/u.test(text)
}

function isQuestion(text: string): boolean {
  return /[?？]$|是不是|是否|吗[？?！!。.]?$|请问|查询|查看|看看|谁是|哪些/u.test(text)
}

function isExplicitNegation(text: string): boolean {
  return /^(?:不要|别|请勿|禁止|不准|千万不要)/u.test(text)
    || /(?:不要|别|请勿|禁止|不准|千万不要).*(?:设成|设为|授予|给|改成|启用|停用)/u.test(text)
}

function capture(text: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(text)?.[1]?.replace(/[「」“”"']/gu, '').trim()
  return value === undefined || value === '' || value.length > 500 ? undefined : value
}

function cleanPrompt(value: string): string {
  return typeof value === 'string' ? value.replaceAll('\0', '').trim().slice(0, 4_000) : ''
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }
