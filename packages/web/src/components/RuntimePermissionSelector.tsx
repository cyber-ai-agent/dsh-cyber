import { FolderSimple, ShieldCheck, ShieldWarning } from '@phosphor-icons/react'
import type { AgentPermissionMode } from '@dsh-cyber/contracts'
import { useI18n } from '../i18n/runtime.js'
import { runtimePermissionCopy } from './runtime-permission-copy.js'

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
    { value: 'read-only', ...runtimePermissionCopy(t, 'read-only'), icon: ShieldCheck },
    { value: 'workspace-write', ...runtimePermissionCopy(t, 'workspace-write'), icon: FolderSimple },
    { value: 'danger-full-access', ...runtimePermissionCopy(t, 'danger-full-access'), icon: ShieldWarning },
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
