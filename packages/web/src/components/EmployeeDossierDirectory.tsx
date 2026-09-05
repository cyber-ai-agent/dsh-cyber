import { GearSix, IdentificationBadge, Plus } from '@phosphor-icons/react'
import type { EmployeeDossier, World } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../types.js'
import { worldExperience } from '../world-experience.js'
import { Avatar } from './Avatar.js'
import { AuthorityBadge } from './AuthorityBadge.js'
import { StatusDot } from './StatusDot.js'
import { DockDetailFold, DockEmptyState, DockRow, DockSurfaceHeader } from './dock/DockSurface.js'

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
  const inviteLabel = roleplay ? '邀请角色' : '新增角色'
  const verifiedSkills = Object.values(dossiers).reduce(
    (total, dossier) => total + dossier.skills.filter((skill) => skill.status === 'verified').length,
    0,
  )
  const milestones = Object.values(dossiers).reduce((total, dossier) => total + dossier.milestones.length, 0)

  return (
    <div className="dossier-directory dock-surface">
      <DockSurfaceHeader
        mark={<IdentificationBadge size={20} />}
        title={directoryTitle}
        summary={roleplay ? '人物设定、关系、成长与剧情履历' : '身份、能力、成长与真实履历'}
        meta={`${employees.length} 名${experience.personLabel} · ${verifiedSkills} 项已验证技能 · ${milestones} 条真实事迹`}
        action={<button className="primary-button" type="button" onClick={onInvite}><Plus size={14} weight="bold" /><span>{inviteLabel}</span></button>}
      />

      <div className="dossier-directory__list">
        {employees.length === 0 ? (
          <DockEmptyState
            mark={<IdentificationBadge size={26} />}
            title={`还没有${experience.personLabel}`}
            description={`${inviteLabel}后，会在这里集中管理身份、技能授权、成长记录和长期履历。`}
            action={<button className="primary-button" type="button" onClick={onInvite}><Plus size={14} />{inviteLabel}</button>}
          />
        ) : employees.map((employee) => {
          const dossier = dossiers[employee.id]
          const profile = dossier?.profile
          const verified = dossier?.skills.filter((skill) => skill.status === 'verified') ?? []
          const latestMilestone = dossier?.milestones[0]
          const latestJournal = dossier?.journals[0]
          return (
            <DockRow
              key={employee.id}
              mark={<button className="avatar-edit-button" type="button" aria-label={`修改${employee.displayName}的名字和头像`} onClick={() => onManage(employee)}>
                <Avatar index={employee.avatarIndex} size="md" label={employee.displayName} status={employee.status} authorityRole={employee.authorityRole} assetUrl={employee.avatarAssetUrl} rendererKind={employee.avatarProfile?.rendererKind} />
              </button>}
              title={<>{employee.displayName}<AuthorityBadge role={employee.authorityRole} /></>}
              secondary={`${employee.role} · ${employee.currentActivity}`}
              badge={<span className="employee-runtime-status">
                <StatusDot status={employee.presence} label={presenceLabel(employee.presence, roleplay)} />
                <StatusDot status={employee.health} label={healthLabel(employee.health)} />
              </span>}
              onOpen={() => onOpen(employee.id)}
              openLabel={`查看角色 ${employee.displayName}`}
              actions={<>
                <button type="button" className="icon-button" aria-label={`管理${employee.displayName}`} onClick={() => onManage(employee)}><GearSix size={15} /></button>
                <button type="button" className="text-button" onClick={() => onDirect(employee)}>直接对话</button>
              </>}
              fold={<DockDetailFold label="设定与履历">
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
              </DockDetailFold>}
            />
          )
        })}
      </div>
    </div>
  )
}

function presenceLabel(presence: CyberEmployee['presence'], roleplay: boolean): string {
  if (roleplay) return presence === 'working' ? '演绎中' : '可登场'
  return presence === 'working' ? '工作中' : '可接任务'
}

function healthLabel(health: CyberEmployee['health']): string {
  return ({ healthy: '运行健康', degraded: '需要检查', blocked: '需要处理' })[health]
}

function localizeRoleSummary(value: string): string {
  return value.replace(/独立\s*Agent/gi, '独立角色').replace(/\bAgent\b/gi, '角色')
}
