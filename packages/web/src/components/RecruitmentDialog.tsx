import { Briefcase, Check, IdentificationCard, ShieldCheck, Sparkle, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import type { EmployeeBlueprint, World } from '@dsh-cyber/contracts'
import { worldExperience } from '../world-experience.js'

interface RecruitmentDialogProps {
  blueprints: EmployeeBlueprint[]
  world: World
  loading: boolean
  recruiting: boolean
  onClose(): void
  onRecruit(blueprint: EmployeeBlueprint, displayName: string | undefined, capabilityGrants: string[]): Promise<void>
}

export function RecruitmentDialog({
  blueprints,
  world,
  loading,
  recruiting,
  onClose,
  onRecruit,
}: RecruitmentDialogProps) {
  const [selectedKey, setSelectedKey] = useState<string>()
  const experience = worldExperience(world)
  const roleplay = experience.kind === 'tavern'
  const BlueprintIcon = roleplay ? IdentificationCard : Briefcase
  const [displayName, setDisplayName] = useState('')
  const [capabilityGrants, setCapabilityGrants] = useState<string[]>([])
  const selected = useMemo(
    () => blueprints.find((blueprint) => blueprintKey(blueprint) === selectedKey) ?? blueprints[0],
    [blueprints, selectedKey],
  )

  useEffect(() => {
    if (selected !== undefined && blueprintKey(selected) !== selectedKey) {
      setSelectedKey(blueprintKey(selected))
      setCapabilityGrants([])
    }
  }, [selected, selectedKey])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="recruitment-dialog" role="dialog" aria-modal="true" aria-labelledby="recruitment-title">
        <header className="dialog-header">
          <div>
            <h2 id="recruitment-title">{experience.marketLabel}</h2>
            <p>{roleplay ? '邀请角色卡会建立当前故事专属的人设、记忆与会话，不会混入其他世界。' : '招聘会创建当前世界专属的 Employee Instance 与版本 1，不会静默生成角色。'}</p>
          </div>
          <button className="icon-button" type="button" aria-label={`关闭${experience.marketLabel}`} onClick={onClose}><X size={18} /></button>
        </header>

        <div className="recruitment-layout">
          <div className="blueprint-list" aria-label={`可添加${experience.peopleLabel}`}>
            {loading ? <div className="dialog-empty">正在读取当前世界的角色蓝图…</div> : null}
            {!loading && blueprints.length === 0 ? <div className="dialog-empty">当前世界还没有兼容的角色蓝图。</div> : null}
            {blueprints.map((blueprint) => (
              <button
                key={`${blueprint.id}@${blueprint.version}`}
                className={`blueprint-card${selected?.id === blueprint.id ? ' is-active' : ''}`}
                type="button"
                onClick={() => { setSelectedKey(blueprintKey(blueprint)); setDisplayName(''); setCapabilityGrants([]) }}
              >
                <span className="blueprint-card__icon"><BlueprintIcon size={20} /></span>
                <span className="blueprint-card__copy">
                  <span><strong>{blueprint.displayName}</strong><small>v{blueprint.version}</small></span>
                  <span>{blueprint.role}</span>
                  <small>{blueprint.summary}</small>
                </span>
                {selected?.id === blueprint.id ? <Check size={17} weight="bold" /> : null}
              </button>
            ))}
          </div>

          <div className="blueprint-detail">
            {selected === undefined ? null : (
              <>
                <div className="blueprint-detail__heading">
                  <span><Sparkle size={18} /></span>
                  <div><h3>{selected.displayName}</h3><p>{selected.role} · 蓝图版本 {selected.version}</p></div>
                </div>
                <p className="blueprint-detail__summary">{selected.summary}</p>
                <label className="dialog-field">
                  <span>{roleplay ? '角色称呼（可选）' : '角色称呼（可选）'}</span>
                  <input value={displayName} placeholder={selected.displayName} onChange={(event) => setDisplayName(event.target.value)} />
                </label>
                <CapabilityGroup title="建议技能" items={selected.requestedSkills} />
                <CapabilityApprovalGroup
                  items={selected.requestedCapabilities}
                  selected={capabilityGrants}
                  onChange={setCapabilityGrants}
                />
                <div className="permission-notice">
                  <ShieldCheck size={18} />
                  <p>{roleplay ? '角色卡只在当前故事世界生效。技能、知识库和工具权限仍按最小权限独立授权。' : '招聘只创建角色身份。技能与工具仍按最小权限单独授权，角色不能自动扩大自己的能力。'}</p>
                </div>
              </>
            )}
          </div>
        </div>

        <footer className="dialog-footer">
          <span>{selected === undefined ? '请选择一份角色蓝图' : `将在当前世界创建独立 Agent：${displayName.trim() || selected.displayName}`}</span>
          <div>
            <button className="text-button" type="button" onClick={onClose}>取消</button>
            <button
              className="primary-button"
              type="button"
              disabled={selected === undefined || recruiting}
              onClick={() => selected && void onRecruit(selected, displayName.trim() || undefined, capabilityGrants)}
            >
              {recruiting ? '正在创建独立 Agent…' : roleplay ? '邀请角色入场' : '确认招聘'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function blueprintKey(blueprint: EmployeeBlueprint): string {
  return `${blueprint.id}@${blueprint.version}`
}

function CapabilityGroup({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="capability-group">
      <h4>{title}</h4>
      <div>{items.length === 0 ? <span>无额外请求</span> : items.map((item) => <span key={item}>{item}</span>)}</div>
    </section>
  )
}

function CapabilityApprovalGroup({
  items,
  selected,
  onChange,
}: {
  items: string[]
  selected: string[]
  onChange(next: string[]): void
}) {
  return (
    <fieldset className="capability-approval-group">
      <legend>逐项批准角色权限</legend>
      {items.length === 0 ? <span>该蓝图未请求额外权限</span> : items.map((item) => (
        <label key={item}>
          <input
            type="checkbox"
            checked={selected.includes(item)}
            onChange={(event) => onChange(event.target.checked
              ? [...selected, item]
              : selected.filter((value) => value !== item))}
          />
          <code>{item}</code>
        </label>
      ))}
    </fieldset>
  )
}
