import { CrownSimple, LockKey, ShieldCheck, WarningCircle } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import {
  RECOMMENDED_ADMIN_PERMISSIONS,
  WORLD_CHARACTER_MANAGEMENT_PERMISSIONS,
  WORLD_CHARACTER_PERMISSION_DESCRIPTORS,
  type WorldCharacterAuthority,
  type WorldCharacterPermission,
  type WorldCharacterPermissionCategory,
  type WorldCharacterRole,
} from '@dsh-cyber/contracts'

export interface WorldPermissionEditorValue {
  role: WorldCharacterRole
  permissionGrants: WorldCharacterPermission[]
  reason: string
}

interface WorldPermissionEditorProps {
  authority?: WorldCharacterAuthority | undefined
  saving?: boolean
  disabled?: boolean
  onSave(value: WorldPermissionEditorValue): Promise<void>
}

const CATEGORY_ORDER: WorldCharacterPermissionCategory[] = [
  'files',
  'settings',
  'characters',
  'extensions',
  'models',
  'audit',
  'conversations',
]

const CATEGORY_LABELS: Record<WorldCharacterPermissionCategory, string> = {
  files: '当前世界文件',
  settings: '世界设置',
  characters: '角色管理',
  extensions: '扩展',
  models: '模型',
  audit: '审计',
  conversations: '会话',
}

const PERMISSION_LABELS: Record<WorldCharacterPermission, string> = {
  'world.files.read': '读取当前世界工作文件',
  'world.files.write': '修改当前世界工作文件',
  'world.settings.read': '查看完整世界设置',
  'world.settings.write': '修改世界设置',
  'world.characters.read': '查看其他角色',
  'world.characters.manage': '管理其他角色',
  'world.permissions.read': '查看角色权限',
  'world.permissions.manage': '管理角色权限',
  'world.packages.read': '查看当前世界扩展',
  'world.packages.manage': '管理当前世界扩展',
  'world.integrations.read': '查看连接状态',
  'world.integrations.manage': '管理世界连接',
  'world.model.read': '查看模型',
  'world.model.assign': '修改世界模型',
  'world.approvals.read': '查看审批',
  'world.trace.read': '查看轨迹',
  'world.conversations.read-metadata': '查看会话列表与元数据',
  'world.conversations.read-content': '读取其他会话正文',
}

const READ_ONLY_ADMIN_PERMISSIONS = RECOMMENDED_ADMIN_PERMISSIONS.filter((permission) =>
  permission.endsWith('.read') || permission === 'world.approvals.read' || permission === 'world.trace.read',
)

const MANAGEMENT_PERMISSION_SET = new Set<WorldCharacterPermission>(WORLD_CHARACTER_MANAGEMENT_PERMISSIONS as readonly WorldCharacterPermission[])
// Connection mutation is intentionally not exposed from the employee editor.
// It needs a separate, explicit integration approval flow and must never be
// enabled by an administrator preset or an accidental checkbox click.
const DISABLED_PERMISSION_SET = new Set<WorldCharacterPermission>(['world.integrations.manage'])

export function stripManagementPermissions(grants: readonly WorldCharacterPermission[]): WorldCharacterPermission[] {
  return grants.filter((permission) => !MANAGEMENT_PERMISSION_SET.has(permission))
}

function filterEditablePermissions(grants: readonly WorldCharacterPermission[]): WorldCharacterPermission[] {
  return grants.filter((permission) => !DISABLED_PERMISSION_SET.has(permission))
}

/**
 * World authority is intentionally separate from EmployeeRevision and
 * capability grants. This editor only speaks the shared world permission
 * vocabulary from contracts, so a new runtime capability cannot silently
 * become a world-management permission.
 */
export function WorldPermissionEditor({ authority, saving = false, disabled = false, onSave }: WorldPermissionEditorProps) {
  const [role, setRole] = useState<WorldCharacterRole>(authority?.role ?? 'member')
  const [grants, setGrants] = useState<WorldCharacterPermission[]>(filterEditablePermissions(authority?.permissionGrants ?? []))
  const [reason, setReason] = useState('调整当前世界职权')
  const [error, setError] = useState<string>()

  useEffect(() => {
    setRole(authority?.role ?? 'member')
    setGrants(filterEditablePermissions(authority?.permissionGrants ?? []))
    setError(undefined)
  }, [authority?.employeeId, authority?.updatedAt, authority?.role, authority?.permissionGrants])

  const grouped = useMemo(() => CATEGORY_ORDER.map((category) => ({
    category,
    permissions: WORLD_CHARACTER_PERMISSION_DESCRIPTORS.filter((descriptor) => descriptor.category === category),
  })).filter((group) => group.permissions.length > 0), [])

  const applyPreset = (nextRole: WorldCharacterRole, nextGrants: readonly WorldCharacterPermission[]) => {
    setRole(nextRole)
    setGrants(filterEditablePermissions(nextGrants))
    setError(undefined)
  }

  const togglePermission = (permission: WorldCharacterPermission) => {
    if (DISABLED_PERMISSION_SET.has(permission)) return
    setGrants((current) => current.includes(permission)
      ? current.filter((item) => item !== permission)
      : [...current, permission])
  }

  const save = async () => {
    if (saving || disabled || !reason.trim()) return
    setError(undefined)
    try {
      await onSave({ role, permissionGrants: filterEditablePermissions(grants), reason: reason.trim() })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '世界权限保存失败')
    }
  }

  return (
    <section className="world-permission-editor" aria-labelledby="world-permission-editor-title">
      <div className="world-permission-editor__heading">
        <div>
          <h3 id="world-permission-editor-title"><ShieldCheck size={18} />世界权限</h3>
          <p>权限只在当前世界生效，与角色 Skill 和底层 Capability 分开管理。</p>
        </div>
        <span className="world-permission-editor__scope"><LockKey size={14} />当前世界</span>
      </div>

      <fieldset className="world-permission-editor__role" disabled={disabled || saving}>
        <legend>世界身份</legend>
        <div className="world-permission-editor__role-options" role="radiogroup" aria-label="世界身份">
          <label className={role === 'member' ? 'is-selected' : ''}>
            <input type="radio" name="world-character-role" value="member" checked={role === 'member'} onChange={() => applyPreset('member', stripManagementPermissions(grants))} />
            <span><strong>普通角色</strong><small>没有默认管理权，仍可拥有明确授予的只读权限。</small></span>
          </label>
          <label className={role === 'administrator' ? 'is-selected' : ''}>
            <input type="radio" name="world-character-role" value="administrator" checked={role === 'administrator'} onChange={() => applyPreset('administrator', grants.length === 0 ? RECOMMENDED_ADMIN_PERMISSIONS : grants)} />
            <span><strong><CrownSimple size={15} weight="fill" />世界管理员</strong><small>可管理当前世界，但不会自动获得 danger-full-access。</small></span>
          </label>
        </div>
      </fieldset>

      {role === 'administrator' ? (
        <div className="world-permission-editor__presets" aria-label="管理员权限预设">
          <span>管理员起始权限</span>
          <button className="secondary-button" type="button" disabled={disabled || saving} onClick={() => applyPreset('administrator', RECOMMENDED_ADMIN_PERMISSIONS)}>恢复推荐管理员权限</button>
          <button className="text-button" type="button" disabled={disabled || saving} onClick={() => applyPreset('administrator', READ_ONLY_ADMIN_PERMISSIONS)}>设为只读管理员</button>
        </div>
      ) : null}

      <div className="world-permission-editor__matrix" aria-label="世界权限矩阵">
        {grouped.map((group) => (
          <fieldset key={group.category} className="world-permission-group" disabled={disabled || saving}>
            <legend>{CATEGORY_LABELS[group.category]}</legend>
            <div className="world-permission-group__rows">
              {group.permissions.map((descriptor) => {
                const checked = grants.includes(descriptor.id)
                const unavailable = DISABLED_PERMISSION_SET.has(descriptor.id)
                return (
                  <label key={descriptor.id} className={`world-permission-row${checked ? ' is-checked' : ''}${unavailable ? ' is-disabled' : ''}`}>
                    <input type="checkbox" checked={checked} disabled={unavailable} onChange={() => togglePermission(descriptor.id)} />
                    <span><strong>{PERMISSION_LABELS[descriptor.id]}</strong><small>{unavailable ? '暂不可授予，需单独安全审批' : descriptor.id}</small></span>
                    {descriptor.sensitive ? <WarningCircle className="is-sensitive" size={16} aria-label="敏感权限" /> : descriptor.management ? <CrownSimple className="is-management" size={15} aria-label="管理权限" /> : null}
                  </label>
                )
              })}
            </div>
          </fieldset>
        ))}
      </div>

      {grants.includes('world.conversations.read-content') ? <div className="world-permission-editor__warning" role="note"><WarningCircle size={17} /><span><strong>敏感权限已开启</strong>读取其他会话正文可能包含用户隐私，仅在确有需要时授予。</span></div> : null}

      <label className="world-permission-editor__reason"><span>这次授权的说明</span><input value={reason} maxLength={160} onChange={(event) => setReason(event.target.value)} placeholder="例如：授权小刘负责本世界设置维护" /></label>
      {error === undefined ? null : <p className="world-permission-editor__error" role="alert">{error}</p>}
      <footer className="world-permission-editor__footer">
        <span>{grants.length} 项世界权限 · 不包含完整访问模式</span>
        <button className="primary-button" type="button" disabled={disabled || saving || !reason.trim()} onClick={() => void save()}>{saving ? '正在保存…' : '保存世界权限'}</button>
      </footer>
    </section>
  )
}
