import { ArrowRight, CalendarDots, Certificate, GearSix, IdentificationBadge, Plus, UsersThree } from '@phosphor-icons/react'
import type { EmployeeDossier, World } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../types.js'
import { worldExperience } from '../world-experience.js'
import { Avatar } from './Avatar.js'
import { AuthorityBadge } from './AuthorityBadge.js'
import { StatusDot } from './StatusDot.js'

interface EmployeeDossierDirectoryProps {
  employees: CyberEmployee[]
  dossiers: Record<string, EmployeeDossier>
  world: World
  onOpen(employeeId: string): void
  onDirect(employee: CyberEmployee): void
  onManage(employee: CyberEmployee): void
  onInvite(): void
}

export function EmployeeDossierDirectory({ employees, dossiers, world, onOpen, onDirect, onManage, onInvite }: EmployeeDossierDirectoryProps) {
  const experience = worldExperience(world)
  const roleplay = experience.kind === 'tavern'
  const directoryTitle = experience.peopleLabel === '角色' ? '角色目录' : `${experience.peopleLabel}角色目录`
  const verifiedSkills = Object.values(dossiers).reduce(
    (total, dossier) => total + dossier.skills.filter((skill) => skill.status === 'verified').length,
    0,
  )
  const milestones = Object.values(dossiers).reduce((total, dossier) => total + dossier.milestones.length, 0)

  return (
    <div className="dossier-directory">
      <header className="dossier-directory__header">
        <div>
          <IdentificationBadge size={22} />
          <span><strong>{directoryTitle}</strong><small>{roleplay ? '人物设定、关系、成长与剧情履历' : '身份、能力、成长与真实履历'}</small></span>
        </div>
        <div className="dossier-directory__header-actions">
          <span>{employees.length} 名{experience.personLabel}</span>
          <button className="primary-button dossier-directory__invite" type="button" onClick={onInvite}>
            <Plus size={14} weight="bold" />
            <span>{roleplay ? '邀请角色' : '新增角色'}</span>
          </button>
        </div>
      </header>

      <div className="dossier-directory__summary" aria-label="角色概览">
        <div><UsersThree size={16} /><strong>{employees.length}</strong><span>在册{experience.personLabel}</span></div>
        <div><Certificate size={16} /><strong>{verifiedSkills}</strong><span>已验证技能</span></div>
        <div><CalendarDots size={16} /><strong>{milestones}</strong><span>真实事迹</span></div>
      </div>

      <div className="dossier-directory__list">
        {employees.length === 0 ? (
          <div className="dossier-directory__empty"><IdentificationBadge size={30} /><strong>还没有角色</strong><p>新增角色后，会在这里集中管理身份、技能授权、成长记录和长期履历。</p><button className="primary-button" type="button" onClick={onInvite}><Plus size={14} />新增第一个角色</button></div>
        ) : employees.map((employee) => {
          const dossier = dossiers[employee.id]
          const profile = dossier?.profile
          const verified = dossier?.skills.filter((skill) => skill.status === 'verified') ?? []
          const latestMilestone = dossier?.milestones[0]
          const latestJournal = dossier?.journals[0]
          return (
            <article key={employee.id} className="dossier-card">
              <header>
                <button className="avatar-edit-button" type="button" aria-label={`修改${employee.displayName}的名字和头像`} onClick={() => onManage(employee)}>
                  <Avatar index={employee.avatarIndex} size="md" label={employee.displayName} status={employee.status} authorityRole={employee.authorityRole} />
                </button>
                <div><strong>{employee.displayName}<AuthorityBadge role={employee.authorityRole} /></strong><span>{employee.role}</span></div>
                <StatusDot status={employee.status} label={statusLabel(employee.status, roleplay)} />
              </header>

              <p className="dossier-card__activity">{employee.currentActivity}</p>

              <div className="dossier-card__traits">
                {(profile?.personalityTraits ?? []).slice(0, 4).map((trait) => <span key={trait}>{trait}</span>)}
                {profile?.birthday === undefined ? null : <span>生日 {profile.birthday}</span>}
                {profile === undefined ? <span>角色信息建立中</span> : null}
              </div>

              <dl>
                <div><dt>技能</dt><dd>{verified.length} 已验证 / {dossier?.skills.length ?? 0} 项</dd></div>
                <div><dt>事迹</dt><dd>{dossier?.milestones.length ?? 0} 条</dd></div>
                <div><dt>日志</dt><dd>{dossier?.journals.length ?? 0} 篇</dd></div>
              </dl>

              <div className="dossier-card__evidence">
                <span>{latestMilestone === undefined ? '尚无里程碑' : `最近事迹 · ${latestMilestone.title}`}</span>
                <small>{latestJournal === undefined ? localizeRoleSummary(employee.summary) : `${latestJournal.localDate} · ${latestJournal.summary}`}</small>
              </div>

              <footer>
                <button type="button" className="icon-button" aria-label={`管理${employee.displayName}`} onClick={() => onManage(employee)}><GearSix size={15} /></button>
                <button type="button" className="text-button" onClick={() => onDirect(employee)}>直接对话</button>
                <button type="button" className="primary-button" onClick={() => onOpen(employee.id)}>查看角色<ArrowRight size={14} /></button>
              </footer>
            </article>
          )
        })}
      </div>
    </div>
  )
}

function statusLabel(status: CyberEmployee['status'], roleplay: boolean): string {
  if (roleplay) return ({ available: '可登场', working: '演绎中', waiting: '等待发言', blocked: '剧情暂停', archived: '已退场' })[status]
  return ({ available: '可接任务', working: '工作中', waiting: '等待中', blocked: '被阻塞', archived: '已归档' })[status]
}

function localizeRoleSummary(value: string): string {
  return value.replace(/独立\s*Agent/gi, '独立角色').replace(/\bAgent\b/gi, '角色')
}
