import {
  ArrowLeft,
  ArrowSquareOut,
  BookOpenText,
  CalendarDots,
  Certificate,
  IdentificationCard,
  LinkSimple,
  UsersThree,
} from '@phosphor-icons/react'
import { useState } from 'react'
import type { EmployeeDossier as EmployeeDossierData } from '@dsh-cyber/contracts'

import type { CyberEmployee } from '../types.js'
import { Avatar } from './Avatar.js'
import { StatusDot } from './StatusDot.js'

type DossierSection = 'profile' | 'skills' | 'milestones' | 'journal' | 'relations'

interface EmployeeDossierProps {
  dossier: EmployeeDossierData
  employees: CyberEmployee[]
  avatarIndex: number
  onDirect(): void
  onManage(): void
  onBack(): void
}

const sections: Array<{ id: DossierSection; label: string; icon: typeof IdentificationCard }> = [
  { id: 'profile', label: '档案', icon: IdentificationCard },
  { id: 'skills', label: '技能', icon: Certificate },
  { id: 'milestones', label: '事迹', icon: CalendarDots },
  { id: 'journal', label: '日志', icon: BookOpenText },
  { id: 'relations', label: '关系', icon: UsersThree },
]

export function EmployeeDossier({ dossier, employees, avatarIndex, onDirect, onManage, onBack }: EmployeeDossierProps) {
  const [section, setSection] = useState<DossierSection>('profile')
  const verified = dossier.skills.filter((skill) => skill.status === 'verified').length
  const profile = dossier.profile

  return (
    <div className="dossier">
      <div className="dossier-breadcrumb">
        <button type="button" onClick={onBack}><ArrowLeft size={14} />全员档案</button>
        <span>{dossier.employee.displayName} / 数字员工档案</span>
      </div>
      <header className="dossier-hero">
        <button className="avatar-edit-button" type="button" aria-label={`修改${dossier.employee.displayName}的名字和头像`} onClick={onManage}>
          <Avatar index={avatarIndex} size="lg" label={dossier.employee.displayName} status={dossier.employee.status} />
        </button>
        <div className="dossier-hero__identity">
          <h2>{dossier.employee.displayName}</h2>
          <p>{dossier.employee.role} · 独立 Agent</p>
          <StatusDot status={dossier.employee.status} label={statusLabel(dossier.employee.status)} />
        </div>
        <div className="dossier-hero__actions">
          <span>角色版本 r{dossier.employee.currentRevision}</span>
          <button className="text-button" type="button" onClick={onManage}>管理</button>
          <button className="primary-button" type="button" onClick={onDirect}>直接对话</button>
        </div>
      </header>

      <div className="dossier-facts" aria-label="员工事实摘要">
        <div><strong>{verified}</strong><span>已验证技能</span></div>
        <div><strong>{dossier.milestones.length}</strong><span>真实事迹</span></div>
        <div><strong>{dossier.journals.length}</strong><span>工作日志</span></div>
      </div>

      <nav className="dossier-tabs" aria-label="员工档案栏目">
        {sections.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? 'is-active' : ''}
              onClick={() => setSection(item.id)}
            >
              <Icon size={15} />
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="dossier-content">
        {section === 'profile' ? (
          <div className="profile-section">
            <div className="profile-row"><span>入职时间</span><strong>{formatDate(dossier.employee.createdAt)}</strong></div>
            <div className="profile-row"><span>生日</span><strong>{profile?.birthday ?? '未设置'}</strong></div>
            <div className="profile-block"><span>身份背景</span><p>{profile?.background ?? '等待建立员工档案。'}</p></div>
            <div className="profile-block">
              <span>性格标签</span>
              <div className="trait-list">{profile?.personalityTraits.map((trait) => <span key={trait}>{trait}</span>)}</div>
            </div>
            <div className="evidence-principle">
              <LinkSimple size={16} />
              <p>属性来自交付、评审、技能验证和故障恢复，不使用虚构忠诚度或智力数值。</p>
            </div>
          </div>
        ) : null}

        {section === 'skills' ? (
          <div className="skill-list">
            {dossier.skills.map((skill) => {
              const evidence = dossier.evidence.filter((item) => skill.evidenceIds.includes(item.id))
              return (
                <article key={skill.skillId} className="skill-record">
                  <header>
                    <div><Certificate size={17} /><strong>{skill.skillId}</strong></div>
                    <StatusDot status={skill.status === 'verified' ? 'available' : 'waiting'} label={skill.status === 'verified' ? '已验证' : '学习中'} />
                  </header>
                  <p>{skill.reason}</p>
                  {evidence.map((item) => (
                    <button key={item.id} className="evidence-link" type="button">
                      <LinkSimple size={14} />
                      <span>{item.summary}</span>
                      <small>{item.kind} · {item.outcome}</small>
                      <ArrowSquareOut size={13} />
                    </button>
                  ))}
                </article>
              )
            })}
          </div>
        ) : null}

        {section === 'milestones' ? (
          <ol className="milestone-timeline">
            {dossier.milestones.map((milestone) => (
              <li key={milestone.id}>
                <span className={`milestone-marker milestone-marker--${milestone.category}`} />
                <time>{formatDate(milestone.occurredAt)}</time>
                <strong>{milestone.title}</strong>
                <p>{milestone.summary}</p>
                <small>{milestone.sourceEventIds.length + milestone.sourceMessageIds.length} 条来源 · {milestone.artifactRefs.length} 个产物</small>
              </li>
            ))}
          </ol>
        ) : null}

        {section === 'journal' ? (
          <div className="journal-list">
            {dossier.journals.map((journal) => (
              <article key={`${journal.localDate}-${journal.revision}`}>
                <header><CalendarDots size={16} /><strong>{journal.localDate}</strong><span>第 {journal.revision} 版</span></header>
                <p>{journal.summary}</p>
                <ul>{journal.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>
                <small>{journal.sourceEventIds.length + journal.sourceMessageIds.length} 条真实记录生成</small>
              </article>
            ))}
          </div>
        ) : null}

        {section === 'relations' ? (
          <div className="relationship-list">
            {dossier.relationships.map((relationship) => {
              const colleague = employees.find((employee) => employee.id === relationship.colleagueId)
              return (
                <article key={relationship.colleagueId}>
                  <Avatar index={colleague?.avatarIndex ?? 7} label={colleague?.displayName ?? '同事'} size="sm" />
                  <div><strong>{colleague?.displayName ?? relationship.colleagueId}</strong><span>{colleague?.role ?? '同事'}</span></div>
                  <dl>
                    <div><dt>协作</dt><dd>{relationship.collaborationCount}</dd></div>
                    <div><dt>评审</dt><dd>{relationship.reviewCount}</dd></div>
                    <div><dt>交接</dt><dd>{relationship.handoffCount}</dd></div>
                  </dl>
                </article>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function statusLabel(status: EmployeeDossierData['employee']['status']): string {
  return ({ available: '可用', working: '工作中', waiting: '等待中', blocked: '被阻塞', archived: '已归档' })[status]
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}
