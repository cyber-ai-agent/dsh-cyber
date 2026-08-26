import { CaretDown, TerminalWindow } from '@phosphor-icons/react'
import type { InstalledPluginCommand } from '@dsh-cyber/contracts'

interface CommandPickerProps {
  commands: InstalledPluginCommand[]
  draft: string
  onDraftChange(value: string): void
  onOpenMarket?: () => void
  onFocus(): void
}

/** Explicit prompt commands only; Agent Skills and automatic transforms stay out of the composer. */
export function CommandPicker({ commands, draft, onDraftChange, onOpenMarket, onFocus }: CommandPickerProps) {
  const explicitCommands = commands.filter((command) => !command.automatic && command.trigger !== 'always')

  return (
    <details className="composer-plugin-picker">
      <summary aria-label="打开命令选择器"><TerminalWindow size={17} /><span>命令</span>{explicitCommands.length > 0 ? <b>{explicitCommands.length}</b> : null}<CaretDown size={13} /></summary>
      <div className="composer-plugin-picker__menu" aria-label="已安装命令">
        <header><strong>已安装命令</strong><span>点击后把指令放入输入框，不会自动发送</span></header>
        {explicitCommands.length === 0 ? <div className="composer-plugin-picker__empty"><TerminalWindow size={22} /><span>还没有可直接使用的命令</span>{onOpenMarket === undefined ? null : <button type="button" onClick={onOpenMarket}>前往扩展市场</button>}</div> : explicitCommands.map((command) => {
          const copy = commandCopy(command)
          return <button key={`${command.packageId}:${command.packageVersion}:${command.trigger}`} className="composer-plugin-picker__item" type="button" onClick={(event) => { onDraftChange(insertCommandTrigger(draft, command.displayTrigger)); event.currentTarget.closest('details')?.removeAttribute('open'); onFocus() }}>
            <span className="composer-plugin-picker__icon"><TerminalWindow size={17} weight="duotone" /></span>
            <span className="composer-plugin-picker__copy"><strong>{copy.name}</strong><small>{copy.description}</small><code>{command.displayTrigger}</code></span>
            <span className="composer-plugin-picker__version">v{command.packageVersion}</span>
          </button>
        })}
      </div>
    </details>
  )
}

function insertCommandTrigger(draft: string, trigger: string): string {
  const separator = draft.trim().length === 0 ? '' : ' '
  return `${draft.trimEnd()}${separator}${trigger} `
}

function commandCopy(command: InstalledPluginCommand): { name: string; description: string } {
  const localized: Record<string, { name: string; description: string }> = {
    'official-decision-log': { name: '决策记录', description: '整理背景、决策、取舍与复核事项。' },
    'official-meeting-notes': { name: '会议纪要助手', description: '整理会议事实、行动项和风险。' },
    'official-release-check': { name: '发布检查', description: '检查阻断项、证据、风险与回滚。' },
    'official-research-brief': { name: '研究简报', description: '整理结论、证据、不确定性和下一步。' },
  }
  return localized[command.packageId] ?? { name: command.displayName, description: command.description || command.summary }
}
