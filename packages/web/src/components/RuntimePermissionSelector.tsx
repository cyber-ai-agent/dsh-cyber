import { FolderSimple, ShieldCheck, ShieldWarning } from '@phosphor-icons/react'
import type { AgentPermissionMode } from '@dsh-cyber/contracts'
import { useI18n } from '../i18n/runtime.js'

export function RuntimePermissionSelector({ value, onChange, legend }: {
  value: AgentPermissionMode
  onChange(value: AgentPermissionMode): void
  legend?: string
}) {
  const { t } = useI18n()
  const legendText = legend ?? t('workbench.permissionCurrent', '默认对话权限')
  const options: Array<{
    value: AgentPermissionMode
    label: string
    description: string
    icon: typeof ShieldCheck
  }> = [
    { value: 'read-only', label: t('workbench.permissionReadOnly', t('workbench.approval', '请求批准')), description: t('workbench.permissionReadOnlyDesc', '可以读取当前世界；编辑文件、联网和风险操作会先询问。'), icon: ShieldCheck },
    { value: 'workspace-write', label: t('workbench.permissionWorkspaceWrite', '帮我批准'), description: t('workbench.permissionWorkspaceWriteDesc', '可以读写当前世界目录，仅对检测到的风险操作请求批准。'), icon: FolderSimple },
    { value: 'danger-full-access', label: t('workbench.permissionFullAccess', '完全访问'), description: t('workbench.permissionFullAccessDesc', '可以访问互联网和当前系统账号可访问的任意文件。'), icon: ShieldWarning },
  ]

  return <fieldset className="runtime-permission-selector">
    <legend>{legendText}</legend>
    {options.map((option) => {
      const Icon = option.icon
      return <label key={option.value} className={value === option.value ? 'is-selected' : ''}>
        <input type="radio" name={legendText} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
        <Icon size={19} aria-hidden="true" />
        <span><strong>{option.label}</strong><small>{option.description}</small></span>
      </label>
    })}
  </fieldset>
}
