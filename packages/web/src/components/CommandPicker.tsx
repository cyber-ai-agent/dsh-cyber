import { ArrowLeft, Command, Plug, PuzzlePiece, Sparkle, TerminalWindow } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { InstalledPluginCommand } from '@dsh-cyber/contracts'

interface CommandPickerProps {
  commands: InstalledPluginCommand[]
  draft: string
  onDraftChange(value: string): void
  onOpenMarket?: () => void
  onFocus(): void
}

type CommandCategory = 'root' | 'commands' | 'skills' | 'plugins'

interface BuiltinCommand {
  trigger: string
  name: string
  description: string
}

interface BuiltinSkill {
  trigger: string
  name: string
  description: string
}

interface SlashCategory {
  id: Exclude<CommandCategory, 'root'>
  name: string
  trigger: string
  description: string
}

const SLASH_CATEGORIES: SlashCategory[] = [
  { id: 'commands', name: '命令', trigger: '/命令', description: '切换话题、查看历史和控制当前回复' },
  { id: 'skills', name: '技能', trigger: '/技能', description: '选择一种工作方法处理接下来的消息' },
  { id: 'plugins', name: '插件', trigger: '/插件', description: '使用已安装插件提供的操作' },
]

const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { trigger: '/换个话题', name: '换个话题', description: '在当前会话开始新话题，保留之前的对话记录' },
  { trigger: '/查看历史', name: '查看历史', description: '打开当前会话的历史消息' },
  { trigger: '/停止回复', name: '停止回复', description: '停止当前正在运行的回复' },
  { trigger: '/清空输入', name: '清空输入', description: '清除当前输入框中的内容' },
]

const BUILTIN_SKILLS: BuiltinSkill[] = [
  { trigger: '/技能/任务协调', name: '任务协调', description: '拆解目标、依赖、负责人、风险与验收标准' },
  { trigger: '/技能/软件实现', name: '软件实现', description: '以小步、可验证和可维护的方式实现需求' },
  { trigger: '/技能/测试验证', name: '测试验证', description: '覆盖正常、边界、失败和回归路径' },
  { trigger: '/技能/研究检索', name: '研究检索', description: '从当前世界可访问资料中检索并回答' },
  { trigger: '/技能/会议纪要', name: '会议纪要', description: '整理会议事实、决定、行动项和风险' },
  { trigger: '/技能/系统诊断', name: '系统诊断', description: '从症状、证据和依赖关系定位系统问题' },
  { trigger: '/技能/内容制作', name: '内容制作', description: '把选题转化为脚本、素材计划和交付清单' },
  { trigger: '/技能/科学推理', name: '科学推理', description: '区分观测、假设、预测和可验证结论' },
]

/** Slash navigation is grouped as commands, skills and plugins so the menu can grow without becoming a flat list. */
export function CommandPicker({ commands, draft, onDraftChange, onOpenMarket, onFocus }: CommandPickerProps) {
  const explicitCommands = commands.filter((command) => !command.automatic && command.trigger !== 'always')
  const invocation = slashInvocation(draft)
  const [category, setCategory] = useState<CommandCategory>('root')

  useEffect(() => {
    if (invocation === undefined) setCategory('root')
  }, [invocation])

  if (invocation === undefined) return null

  const query = invocation.query.toLocaleLowerCase()
  const matchesQuery = (values: string[]) => query.length === 0 || values.some((value) => value.toLocaleLowerCase().includes(query))
  const openCategory = (next: Exclude<CommandCategory, 'root'>) => {
    setCategory(next)
    onDraftChange(`${draft.slice(0, invocation.start)}/`)
    onFocus()
  }
  const goBack = () => {
    setCategory('root')
    onDraftChange(`${draft.slice(0, invocation.start)}/`)
    onFocus()
  }
  const selectTrigger = (trigger: string) => {
    onDraftChange(replaceSlashInvocation(draft, invocation.start, trigger))
    onFocus()
  }

  const visibleCategories = SLASH_CATEGORIES.filter((item) => matchesQuery([item.trigger, item.name, item.description]))
  const visibleBuiltinCommands = BUILTIN_COMMANDS.filter((item) => matchesQuery([item.trigger, item.name, item.description]))
  const visibleBuiltinSkills = BUILTIN_SKILLS.filter((item) => matchesQuery([item.trigger, item.name, item.description]))
  const visiblePluginCommands = explicitCommands.filter((command) => {
    const copy = commandCopy(command)
    return matchesQuery([command.displayTrigger, command.trigger, command.displayName, command.summary, command.description, copy.name, copy.description])
  })
  const categoryInfo = category === 'root' ? undefined : SLASH_CATEGORIES.find((item) => item.id === category)

  return (
    <div className="composer-plugin-picker composer-plugin-picker--slash" role="dialog" aria-label="斜杠操作">
      <div className="composer-plugin-picker__menu" aria-label={category === 'root' ? '斜杠分类' : `${categoryInfo?.name ?? '斜杠'}操作`}>
        <header>
          {category === 'root' ? null : <button className="composer-plugin-picker__back" type="button" aria-label="返回斜杠分类" onClick={goBack}><ArrowLeft size={16} /></button>}
          <div>
            <strong><TerminalWindow size={16} />{category === 'root' ? '斜杠操作' : categoryInfo?.name}</strong>
            <span>{category === 'root' ? '先选择分类，再选择具体操作' : categoryInfo?.description}</span>
          </div>
        </header>

        {category === 'root' ? visibleCategories.map((item) => <button key={item.id} className="composer-plugin-picker__category" type="button" role="option" onClick={() => openCategory(item.id)}>
          <span className="composer-plugin-picker__category-icon">{item.id === 'commands' ? <Command size={19} /> : item.id === 'skills' ? <Sparkle size={19} /> : <Plug size={19} />}</span>
          <span><strong>{item.name}</strong><small>{item.description}</small></span>
          <code>{item.trigger}</code>
        </button>) : null}

        {category === 'commands' ? <BuiltinCommandList items={visibleBuiltinCommands} onSelect={selectTrigger} /> : null}
        {category === 'skills' ? <BuiltinSkillList items={visibleBuiltinSkills} onSelect={selectTrigger} /> : null}
        {category === 'plugins' ? <PluginCommandList items={visiblePluginCommands} onSelect={selectTrigger} onOpenMarket={onOpenMarket === undefined ? undefined : () => { onDraftChange(draft.slice(0, invocation.start)); onOpenMarket() }} hasQuery={query.length > 0} /> : null}

        {category === 'root' && visibleCategories.length === 0 ? <EmptyCommandState message="没有匹配的斜杠分类" /> : null}
      </div>
    </div>
  )
}

function BuiltinCommandList({ items, onSelect }: { items: BuiltinCommand[]; onSelect(trigger: string): void }) {
  if (items.length === 0) return <EmptyCommandState message="没有匹配的命令" />
  return <>{items.map((item) => <button key={item.trigger} className="composer-plugin-picker__item composer-plugin-picker__item--builtin" type="button" role="option" onClick={() => onSelect(item.trigger)}>
    <span className="composer-plugin-picker__icon"><Command size={17} weight="duotone" /></span>
    <span className="composer-plugin-picker__copy"><strong>{item.name}</strong><small>{item.description}</small><code>{item.trigger}</code></span>
    <span className="composer-plugin-picker__version">内置</span>
  </button>)}</>
}

function BuiltinSkillList({ items, onSelect }: { items: BuiltinSkill[]; onSelect(trigger: string): void }) {
  if (items.length === 0) return <EmptyCommandState message="没有匹配的技能" />
  return <>{items.map((item) => <button key={item.trigger} className="composer-plugin-picker__item composer-plugin-picker__item--builtin" type="button" role="option" onClick={() => onSelect(item.trigger)}>
    <span className="composer-plugin-picker__icon"><PuzzlePiece size={17} weight="duotone" /></span>
    <span className="composer-plugin-picker__copy"><strong>{item.name}</strong><small>{item.description}</small><code>{item.trigger}</code></span>
    <span className="composer-plugin-picker__version">内置</span>
  </button>)}</>
}

function PluginCommandList({ items, onSelect, onOpenMarket, hasQuery }: { items: InstalledPluginCommand[]; onSelect(trigger: string): void; onOpenMarket: (() => void) | undefined; hasQuery: boolean }) {
  if (items.length === 0) return <div className="composer-plugin-picker__empty"><Plug size={22} /><span>{hasQuery ? '没有匹配的插件操作' : '还没有已安装的插件操作'}</span>{onOpenMarket === undefined ? null : <button type="button" onClick={onOpenMarket}>前往扩展市场</button>}</div>
  return <>{items.map((command) => {
    const copy = commandCopy(command)
    return <button key={`${command.packageId}:${command.packageVersion}:${command.trigger}`} className="composer-plugin-picker__item" type="button" role="option" onClick={() => onSelect(command.displayTrigger)}>
      <span className="composer-plugin-picker__icon"><Plug size={17} weight="duotone" /></span>
      <span className="composer-plugin-picker__copy"><strong>{copy.name}</strong><small>{copy.description}</small><code>{command.displayTrigger}</code></span>
      <span className="composer-plugin-picker__version">插件</span>
    </button>
  })}</>
}

function EmptyCommandState({ message }: { message: string }) {
  return <div className="composer-plugin-picker__empty"><TerminalWindow size={22} /><span>{message}</span></div>
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
    'official-decision-log': { name: '决策记录', description: '整理背景、决策、取舍与复核事项' },
    'official-meeting-notes': { name: '会议纪要助手', description: '整理会议事实、行动项和风险' },
    'official-release-check': { name: '发布检查', description: '检查阻断项、证据、风险与回滚' },
    'official-research-brief': { name: '研究简报', description: '整理结论、证据、不确定性和下一步' },
  }
  return localized[command.packageId] ?? { name: command.displayName, description: command.description || command.summary }
}
