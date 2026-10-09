import { ArrowsClockwise, Certificate } from '@phosphor-icons/react'
import { lazy, Suspense, useEffect, useState } from 'react'
import type { EmployeeBlueprint, EmployeeDossier, World } from '@dsh-cyber/contracts'

import { api } from '../api.js'
import { DockEmptyState } from './dock/DockSurface.js'
import { groupSkillItems } from './skill-entity-grouping.js'
import { normalizeSkillCatalog, skillCatalogErrorMessage, worldBlueprintCatalogPath, worldSkillCatalogPath, type SkillCatalogEntry } from './skill-catalog.js'
import { roleSkillReadiness, type SkillSetupTarget } from './role-skill-readiness.js'
import './EmployeeSkillsPanel.css'

const SkillCenterDialog = lazy(async () => ({ default: (await import('../features/skill-center/SkillCenterDialog.js')).SkillCenterDialog }))

interface Props {
  dossier: EmployeeDossier
  world: World
  worlds: World[]
  onManageSkills(): void
}

export function EmployeeSkillsPanel(props: Props) {
  if (props.dossier.employee.worldId !== props.world.id) return <p role="status">正在读取当前世界的角色…</p>
  return <RoleSkillsContent key={`${props.world.id}:${props.dossier.employee.id}:${props.dossier.employee.currentRevision}`} {...props} />
}

function RoleSkillsContent({ dossier, world, worlds, onManageSkills }: Props) {
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>()
  const [requested, setRequested] = useState<string[]>([])
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  const [center, setCenter] = useState<'world' | 'catalog'>()
  const employee = dossier.employee
  const revision = dossier.revisions.find((item) => item.revision === employee.currentRevision)

  useEffect(() => {
    let cancelled = false
    setCatalog(undefined); setRequested([]); setError(undefined)
    void Promise.all([
      api<unknown>(worldSkillCatalogPath(world.id)),
      api<{ items: EmployeeBlueprint[] }>(worldBlueprintCatalogPath(world.id)),
    ]).then(([skills, blueprints]) => {
      if (cancelled) return
      setCatalog(normalizeSkillCatalog(skills))
      setRequested(blueprints.items.find((item) => item.id === employee.blueprintId && item.version === employee.blueprintVersion)?.requestedSkills ?? [])
    }).catch((cause: unknown) => { if (!cancelled) setError(skillCatalogErrorMessage(cause)) })
    return () => { cancelled = true }
  }, [world.id, employee.blueprintId, employee.blueprintVersion, reload])

  const openSetup = (target: SkillSetupTarget): void => {
    if (target === 'role') onManageSkills()
    else setCenter(target)
  }
  const byId = new Map(catalog?.map((entry) => [entry.id, entry]))
  const grants = new Set(revision?.skillGrants ?? [])
  const relatedIds = [...new Set([...grants, ...requested])]
  const groups = groupSkillItems(relatedIds.map((id) => {
    const entry = byId.get(id)
    return { ...(entry ?? { id, displayName: id, summary: '' }), readiness: roleSkillReadiness(entry, grants.has(id)), granted: grants.has(id) }
  }))
  const usableCount = groups.filter((group) => group.entries.some((entry) => entry.readiness.usable)).length
  const grantableCount = groupSkillItems((catalog ?? []).filter((entry) => roleSkillReadiness(entry, false).target === 'role' && !grants.has(entry.id))).length

  return <section className="role-skills" aria-label={`${employee.displayName}的技能可用性`}>
    <header className="role-skills__header">
      <div><h3>当前角色技能</h3><p>{world.name} · {employee.displayName}</p></div>
      <button className="icon-button" type="button" aria-label="刷新角色技能" onClick={() => setReload((value) => value + 1)}><ArrowsClockwise size={16} /></button>
    </header>
    {error !== undefined ? <div className="role-skills__notice" role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={() => setReload((value) => value + 1)}>重试读取技能</button></div>
      : catalog === undefined ? <p role="status">正在检查当前角色的技能…</p>
        : revision === undefined ? <p role="alert">尚未读取到当前角色版本，请返回角色目录后重试。</p>
          : <>
            {grants.size === 0 ? <DockEmptyState mark={<Certificate size={24} />} title="尚未授权角色技能" description="安装技能或在世界中启用后，还需为这个角色明确授权。" action={<button type="button" className="primary-button" onClick={onManageSkills}>管理角色技能</button>} /> : <div className="role-skills__summary"><strong>{usableCount} 项可使用</strong><button type="button" className="secondary-button" onClick={onManageSkills}>管理角色技能</button></div>}
            {groups.length === 0 ? null : <div className="role-skills__list">{groups.map((group) => {
              const available = group.entries.filter((entry) => entry.readiness.usable).length
              const labels = [...new Set(group.entries.map((entry) => entry.readiness.label))]
              const targets = [...new Set(group.entries.flatMap((entry) => entry.readiness.target === undefined || entry.readiness.target === 'role' ? [] : [entry.readiness.target]))]
              return <article className="role-skills__row" key={group.key}>
                <header><strong>{group.displayName}</strong><span className={available === group.entries.length ? 'is-usable' : ''}>{labels.length === 1 ? labels[0] : `${available}/${group.entries.length} 项可使用`}</span></header>
                {group.entries.length === 1 ? <p>{group.entries[0]!.readiness.reason}{!group.entries[0]!.granted && group.entries[0]!.readiness.target !== 'role' ? ' 角色也尚未授权。' : ''}</p> : <details><summary>查看 {group.entries.length} 项能力的状态</summary><ul>{group.entries.map((entry) => <li key={entry.id}><strong>{entry.displayName}</strong><span>{entry.readiness.label}{entry.granted ? ' · 已授权' : ' · 未授权'}</span><p>{entry.readiness.reason}</p></li>)}</ul></details>}
                {targets.length === 0 ? null : <div className="role-skills__actions">{targets.map((target) => <button key={target} type="button" className="secondary-button" onClick={() => openSetup(target)}>{setupLabel(target)}</button>)}</div>}
              </article>
            })}</div>}
            <p className="role-skills__note">可使用表示授权与世界设置已就绪；连接、依赖和具体动作审批仍在执行时检查，不代表已验证。</p>
            <div className="role-skills__more"><span>{grantableCount > 0 ? `${grantableCount} 项技能可为此角色配置` : '可到技能中心检查可用来源与世界设置'}</span><button type="button" className="secondary-button" onClick={() => setCenter('world')}>世界技能设置</button></div>
          </>}
    <details className="role-skills__evidence"><summary>成长与验证记录 · {dossier.skills.length}</summary>{dossier.skills.length === 0 ? <p>暂无技能成长记录。验证状态来自已保存的技能证据。</p> : dossier.skills.map((skill) => <article key={skill.skillId}><header><strong>{byId.get(skill.skillId)?.displayName ?? skill.skillId}</strong><span>{skill.status === 'verified' ? '已验证' : '学习中'}</span></header><p>{skill.reason}</p>{dossier.evidence.filter((item) => skill.evidenceIds.includes(item.id)).map((item) => <p key={item.id}>{item.summary}</p>)}</article>)}</details>
    {center === undefined ? null : <Suspense fallback={<p role="status">正在打开技能中心…</p>}><SkillCenterDialog key={world.id} world={world} worlds={worlds} initialTab={center === 'world' ? 'settings' : 'list'} initialScopeKey={`world:${world.id}`} onClose={() => { setCenter(undefined); setReload((value) => value + 1) }} /></Suspense>}
  </section>
}

function setupLabel(target: SkillSetupTarget): string {
  return target === 'role' ? '管理角色技能' : target === 'world' ? '世界技能设置' : '查看技能来源'
}
