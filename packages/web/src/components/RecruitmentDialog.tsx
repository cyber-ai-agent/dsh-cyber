import { Briefcase, Check, IdentificationCard, ShieldCheck, Sparkle, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import type { EmployeeBlueprint, EmployeeInstance, World, WorldSnapshot } from '@dsh-cyber/contracts'
import { worldExperience } from '../world-experience.js'

interface RecruitmentDialogProps {
  blueprints: EmployeeBlueprint[]
  employees?: EmployeeInstance[]
  world: World
  loading: boolean
  recruiting: boolean
  onClose(): void
  onRecruit(blueprint: EmployeeBlueprint, displayName: string | undefined, capabilityGrants: string[]): Promise<void>
}

export function RecruitmentDialog({ blueprints, employees, world, loading, recruiting, onClose, onRecruit }: RecruitmentDialogProps) {
  const [selectedKey, setSelectedKey] = useState<string>()
  const [loadedEmployees, setLoadedEmployees] = useState<EmployeeInstance[]>([])
  const currentEmployees = employees ?? loadedEmployees
  const experience = worldExperience(world)
  const roleplay = experience.kind === 'tavern'
  const BlueprintIcon = roleplay ? IdentificationCard : Briefcase
  const dialogTitle = roleplay ? '邀请角色' : '新增角色'
  const [displayName, setDisplayName] = useState('')
  const [capabilityGrants, setCapabilityGrants] = useState<string[]>([])
  const selected = useMemo(
    () => blueprints.find((blueprint) => blueprintKey(blueprint) === selectedKey) ?? blueprints[0],
    [blueprints, selectedKey],
  )
  const selectedExisting = useMemo(
    () => selected === undefined
      ? []
      : currentEmployees.filter((employee) => employee.blueprintId === selected.id && employee.blueprintVersion === selected.version),
    [currentEmployees, selected],
  )
  const proposedName = (displayName.trim() || selected?.displayName || '').trim()
  const duplicateName = proposedName !== '' && currentEmployees.some((employee) => employee.displayName === proposedName)

  useEffect(() => {
    if (employees !== undefined) return
    let cancelled = false
    void fetch(`/api/worlds/${encodeURIComponent(world.id)}/snapshot`)
      .then(async (response) => response.ok ? await response.json() as WorldSnapshot : undefined)
      .then((snapshot) => { if (!cancelled && snapshot !== undefined) setLoadedEmployees(snapshot.employees) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [employees, world.id])

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
          <div><h2 id="recruitment-title">{dialogTitle}</h2><p>从当前已安装或内置的角色模板中创建独立实例。新的模板请先到顶部「市场 → 角色」安装。</p></div>
          <button className="icon-button" type="button" aria-label={`关闭${dialogTitle}`} onClick={onClose}><X size={18} /></button>
        </header>

        <div className="recruitment-layout">
          <div className="blueprint-list" aria-label="可用角色模板">
            {loading ? <div className="dialog-empty">正在读取当前世界可用的角色模板…</div> : null}
            {!loading && blueprints.length === 0 ? <div className="dialog-empty">当前世界还没有兼容模板。可以到顶部「市场 → 角色」安装，或通过创意工坊创建。</div> : null}
            {blueprints.map((blueprint) => {
              const existingCount = currentEmployees.filter((employee) => employee.blueprintId === blueprint.id && employee.blueprintVersion === blueprint.version).length
              return (
                <button key={`${blueprint.id}@${blueprint.version}`} className={`blueprint-card${selected?.id === blueprint.id ? ' is-active' : ''}`} type="button" onClick={() => { setSelectedKey(blueprintKey(blueprint)); setDisplayName(''); setCapabilityGrants([]) }}>
                  <span className="blueprint-card__icon"><BlueprintIcon size={20} /></span>
                  <span className="blueprint-card__copy"><span><strong>{blueprint.displayName}</strong><small>v{blueprint.version}</small></span><span>{blueprint.role}</span><small>{blueprint.summary}</small>{existingCount > 0 ? <small className="blueprint-card__existing">当前世界已有 {existingCount} 名</small> : null}</span>
                  {selected?.id === blueprint.id ? <Check size={17} weight="bold" /> : null}
                </button>
              )
            })}
          </div>

          <div className="blueprint-detail">
            {selected === undefined ? null : <>
              <div className="blueprint-detail__heading"><span><Sparkle size={18} /></span><div><h3>{selected.displayName}</h3><p>{selected.role} · 模板版本 {selected.version}</p></div></div>
              <p className="blueprint-detail__summary">{selected.summary}</p>
              {selectedExisting.length > 0 ? <div className="permission-notice permission-notice--existing"><IdentificationCard size={18} /><p>当前世界已有 {selectedExisting.length} 名角色来自这份模板：{selectedExisting.map((employee) => employee.displayName).join('、')}。仍可创建新的独立角色实例，每个实例拥有自己的会话、档案和成长记录。</p></div> : null}
              <label className="dialog-field"><span>角色名字（可选）</span><input value={displayName} placeholder={selectedExisting.length > 0 ? `${selected.displayName} ${selectedExisting.length + 1}` : selected.displayName} onChange={(event) => setDisplayName(event.target.value)} />{duplicateName ? <small className="dialog-field__warning">当前世界已有同名角色，建议换一个名字以便区分。</small> : null}</label>
              <CapabilityGroup title="模板请求的 Skills" items={selected.requestedSkills} />
              <CapabilityApprovalGroup items={selected.requestedCapabilities} selected={capabilityGrants} onChange={setCapabilityGrants} />
              <div className="permission-notice"><ShieldCheck size={18} /><p>创建角色不会自动授予 Skill。Skill 请求与实际授权分离，创建后请在角色设置中逐项批准；底层 Capability 仍按最小权限选择。</p></div>
            </>}
          </div>
        </div>

        <footer className="dialog-footer"><span>{selected === undefined ? '请选择一份角色模板' : `将在当前世界创建独立角色：${displayName.trim() || selected.displayName}`}</span><div><button className="text-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" disabled={selected === undefined || recruiting} onClick={() => selected && void onRecruit(selected, displayName.trim() || undefined, capabilityGrants)}>{recruiting ? '正在创建角色…' : selectedExisting.length > 0 ? '再创建一名' : roleplay ? '邀请角色入场' : '确认新增'}</button></div></footer>
      </section>
    </div>
  )
}

function blueprintKey(blueprint: EmployeeBlueprint): string { return `${blueprint.id}@${blueprint.version}` }

function CapabilityGroup({ title, items }: { title: string; items: string[] }) {
  return <section className="capability-group"><h4>{title}</h4><div>{items.length === 0 ? <span>无额外请求</span> : items.map((item) => <span key={item}>{item}</span>)}</div></section>
}

function CapabilityApprovalGroup({ items, selected, onChange }: { items: string[]; selected: string[]; onChange(next: string[]): void }) {
  return <fieldset className="capability-approval-group"><legend>底层 Capability（按需批准）</legend>{items.length === 0 ? <span>该角色模板未请求额外底层权限</span> : items.map((item) => <label key={item}><input type="checkbox" checked={selected.includes(item)} onChange={(event) => onChange(event.target.checked ? [...selected, item] : selected.filter((value) => value !== item))}/><code>{item}</code></label>)}</fieldset>
}
