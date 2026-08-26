import { TerminalWindow } from '@phosphor-icons/react'
import type { InstalledPluginCommand } from '@dsh-cyber/contracts'

interface CommandPickerProps {
  commands: InstalledPluginCommand[]
  draft: string
  onDraftChange(value: string): void
  onOpenMarket?: () => void
  onFocus(): void
}

/** Explicit prompt commands only; Agent Skills and automatic transforms stay out of the slash menu. */
export function CommandPicker({ commands, draft, onDraftChange, onOpenMarket, onFocus }: CommandPickerProps) {
  const explicitCommands = commands.filter((command) => !command.automatic && command.trigger !== 'always')
  const invocation = slashInvocation(draft)

  if (invocation === undefined) return null

  const query = invocation.query.toLocaleLowerCase()
  const visibleCommands = explicitCommands.filter((command) => {
    if (query.length === 0) return true
    const copy = commandCopy(command)
    return [command.displayTrigger, command.trigger, command.displayName, command.summary, command.description, copy.name, copy.description]
      .some((value) => value.toLocaleLowerCase().includes(query))
  })
  const selectCommand = (command: InstalledPluginCommand) => {
    onDraftChange(replaceSlashInvocation(draft, invocation.start, command.displayTrigger))
    onFocus()
  }

  return (
    <div className="composer-plugin-picker composer-plugin-picker--slash" role="dialog" aria-label="斜杠操作">
      <div className="composer-plugin-picker__menu" aria-label="已安装命令">
        <header><strong><TerminalWindow size={16} />斜杠操作</strong><span>继续输入筛选操作，选择后放回消息输入框</span></header>
        {visibleCommands.length === 0 ? <div className="composer-plugin-picker__empty"><TerminalWindow size={22} /><span>{explicitCommands.length === 0 ? '还没有可直接使用的操作' : '没有匹配的操作'}</span>{onOpenMarket === undefined ? null : <button type="button" onClick={() => { onDraftChange(draft.slice(0, invocation.start)); onOpenMarket() }}>前往扩展市场</button>}</div> : visibleCommands.map((command) => {
          const copy = commandCopy(command)
          return <button key={`${command.packageId}:${command.packageVersion}:${command.trigger}`} className="composer-plugin-picker__item" type="button" role="option" onClick={() => selectCommand(command)}>
            <span className="composer-plugin-picker__icon"><TerminalWindow size={17} weight="duotone" /></span>
            <span className="composer-plugin-picker__copy"><strong>{copy.name}</strong><small>{copy.description}</small><code>{command.displayTrigger}</code></span>
            <span className="composer-plugin-picker__version">v{command.packageVersion}</span>
          </button>
        })}
      </div>
    </div>
  )
}

export function slashInvocation(draft: string): { start: number; query: string } | undefined {
  const match = /(^|\s)\/([^\s\/]*)$/.exec(draft)
  if (match === null || match.index === undefined) return undefined
  return { start: match.index + (match[1] ?? '').length, query: match[2] ?? '' }
}

export function replaceSlashInvocation(draft: string, start: number, trigger: string): string {
  return `${draft.slice(0, start)}${trigger} `
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
