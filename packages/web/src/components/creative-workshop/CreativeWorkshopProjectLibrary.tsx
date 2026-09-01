import { Archive, ArrowCounterClockwise, ArrowRight, Copy, Cube, Plus, ShieldCheck, SlidersHorizontal, Sparkle, Trash, UsersThree, WarningCircle } from '@phosphor-icons/react'
import { useState } from 'react'
import type { WorldTemplateManifest } from '@dsh-cyber/contracts'
import type { CharacterSkillDescriptor, WorkshopProjectStatus, WorkshopProjectView } from '@dsh-cyber/contracts/creative-platform'

import { useI18n } from '../../i18n/runtime.js'
import './CreativeWorkshopProjectLibrary.css'

interface CreativeWorkshopProjectLibraryProps {
  projects: WorkshopProjectView[]
  templates?: WorldTemplateManifest[]
  selectedProject?: WorkshopProjectView
  skills: CharacterSkillDescriptor[]
  notice?: string
  onSelect(project: WorkshopProjectView): void
  onCreate(templateId?: string): void
  onDuplicate(project: WorkshopProjectView): void
  onOpenWorld(worldId: string): void
  onArchive(project: WorkshopProjectView): void
  onRestore(project: WorkshopProjectView): void
  onDelete(project: WorkshopProjectView): void
}

export function CreativeWorkshopProjectLibrary({
  projects,
  templates = [],
  selectedProject,
  skills,
  notice,
  onSelect,
  onCreate,
  onDuplicate,
  onOpenWorld,
  onArchive,
  onRestore,
  onDelete,
}: CreativeWorkshopProjectLibraryProps) {
  const { locale, t } = useI18n()
  const [tab, setTab] = useState<WorkshopProjectStatus>('active')
  const [pendingDeleteId, setPendingDeleteId] = useState<string>()
  const skillNames = new Map(skills.map((skill) => [skill.id, skill.displayName]))
  const visibleProjects = projects.filter((project) => project.status === tab)

  // 1. 当没有项目时：呈现一体化、饱满充实、高审美的创作起航大厅 (Creative Workshop Hub)
  // 彻底消灭“两个新建按钮”和“右侧大片死黑空白”！
  if (projects.length === 0) {
    return (
      <div className="creative-workshop-hub">
        {/* 顶部 Hero 欢迎卡片 */}
        <section className="creative-workshop-hub__hero">
          <div className="creative-workshop-hub__hero-glow" aria-hidden="true" />
          <div className="creative-workshop-hub__hero-content">
            <h3>{t('workshop.hub.heroTitle', '打造专属的赛博智能体世界')}</h3>
            <p>{t('workshop.hub.heroDescription', '跟随分步引导设定空间规则、角色具身语义与技能权限。项目保存在本机，资产永久归你所有。')}</p>
          </div>
          <div className="creative-workshop-hub__hero-actions">
            <button
              type="button"
              className="primary-button creative-workshop-hero-btn"
              onClick={() => onCreate()}
            >
              <Plus size={16} />
              <span>{t('workshop.hub.createEmpty', '新建空白世界')}</span>
            </button>
          </div>
        </section>

        {/* 中部：推荐模板快速起步 */}
        {templates.length > 0 ? (
          <section className="creative-workshop-hub__section">
            <header className="creative-workshop-hub__section-header">
              <div>
                <h4>{t('workshop.hub.quickStart', '从世界模板快速起步')}</h4>
                <p>{t('workshop.hub.quickStartSub', '选择预置空间场景，一键创建包含初始角色的新世界')}</p>
              </div>
            </header>
            <div className="creative-workshop-templates-grid">
              {templates.map((tpl) => {
                const templateName = t(`workshop.template.${tpl.id}.name`, tpl.displayName)
                const templateSummary = t(`workshop.template.${tpl.id}.summary`, tpl.summary ?? '')
                return (
                <article
                  key={tpl.id}
                  className="creative-workshop-template-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => onCreate(tpl.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onCreate(tpl.id)
                    }
                  }}
                >
                  <div className="creative-workshop-template-card__header">
                    <span className="creative-workshop-template-icon">
                      <Cube size={20} />
                    </span>
                    <strong>{templateName}</strong>
                  </div>
                  <p className="creative-workshop-template-card__summary">{templateSummary}</p>
                  <footer className="creative-workshop-template-card__footer">
                    <span>{t('workshop.hub.useTemplate', '以此模板起步')}</span>
                    <ArrowRight size={14} />
                  </footer>
                </article>
                )
              })}
            </div>
          </section>
        ) : null}

        {/* 底部：三步创作工作流微晶指引 */}
        <section className="creative-workshop-hub__section">
          <header className="creative-workshop-hub__section-header">
            <h4>{t('workshop.hub.workflowTitle', '三步完成世界构建')}</h4>
          </header>
          <div className="creative-workshop-workflow-grid">
            <div className="creative-workshop-workflow-step">
              <span className="step-icon"><SlidersHorizontal size={18} /></span>
              <strong>{t('workshop.hub.step1Title', '1. 空间与世界观')}</strong>
              <p>{t('workshop.hub.step1Desc', '设定主题场景、长期规则与空间环境交互')}</p>
            </div>
            <div className="creative-workshop-workflow-step">
              <span className="step-icon"><UsersThree size={18} /></span>
              <strong>{t('workshop.hub.step2Title', '2. 角色具身语义')}</strong>
              <p>{t('workshop.hub.step2Desc', '定义形象岗位、性格特征与具身空间感知')}</p>
            </div>
            <div className="creative-workshop-workflow-step">
              <span className="step-icon"><ShieldCheck size={18} /></span>
              <strong>{t('workshop.hub.step3Title', '3. 技能与动作授权')}</strong>
              <p>{t('workshop.hub.step3Desc', '按需授予受信任外部动作与审批执行边界')}</p>
            </div>
          </div>
        </section>
      </div>
    )
  }

  // 2. 当已有项目时：呈现规范的双栏项目管理器
  return (
    <div className="creative-workshop-library">
      <aside className="creative-workshop-project-list">
        <header>
          <div>
            <strong>{t('workshop.library.title', '我的本地项目')}</strong>
            <small>{t('workshop.library.count', '{count} 个世界项目', { count: visibleProjects.length })}</small>
          </div>
          <button type="button" className="primary-button" onClick={() => onCreate()}>
            <Plus size={14} />
            {t('workshop.library.new', '新建')}
          </button>
        </header>

        <div className="creative-workshop-project-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'active'}
            className={tab === 'active' ? 'is-active' : ''}
            onClick={() => { setTab('active'); setPendingDeleteId(undefined) }}
          >
            {t('workshop.library.tabActive', '我的项目')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'archived'}
            className={tab === 'archived' ? 'is-active' : ''}
            onClick={() => { setTab('archived'); setPendingDeleteId(undefined) }}
          >
            {t('workshop.library.tabArchived', '归档项目')}
          </button>
        </div>

        <div className="creative-workshop-project-items">
          {visibleProjects.length === 0 && tab === 'archived' ? (
            <p className="creative-workshop-project-empty">{t('workshop.library.emptyArchived', '归档里还没有项目。')}</p>
          ) : null}
          {visibleProjects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={selectedProject?.id === project.id ? 'is-active' : ''}
              onClick={() => onSelect(project)}
            >
              <span className="creative-workshop-project-icon"><Cube size={17} /></span>
              <span>
                <strong>{project.displayName}</strong>
                <small>{t('workshop.library.roleCount', '{count} 个角色', { count: project.roles.length })} · {formatDate(project.updatedAt, locale)}</small>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <main className="creative-workshop-project-detail">
        {notice === undefined ? null : <p className="creative-workshop-project-notice" role="status">{notice}</p>}
        {selectedProject === undefined || selectedProject.status !== tab ? (
          <div className="creative-workshop-project-placeholder">
            <Cube size={34} />
            <strong>{t('workshop.library.select', '选择一个项目查看详情')}</strong>
            <p>{t('workshop.library.worldSaved', '世界设置、角色和生成内容都保存在当前设备。')}</p>
          </div>
        ) : (
          <>
            <header className="creative-workshop-project-detail__header">
              <div>
                <span>
                  {t('workshop.library.localProject', '本地世界项目')}
                  {selectedProject.status === 'archived'
                    ? <em className="creative-workshop-project-badge">{t('workshop.library.archivedBadge', '已归档')}</em>
                    : null}
                </span>
                <h3>{selectedProject.displayName}</h3>
                <p>{selectedProject.scenario || selectedProject.lore || t('workshop.library.scenarioEmpty', '尚未填写世界说明。')}</p>
              </div>
              <div>
                <button type="button" className="secondary-button" onClick={() => onDuplicate(selectedProject)}>
                  <Copy size={14} />
                  {t('workshop.library.duplicate', '基于此项目创建副本')}
                </button>
                {selectedProject.status === 'active' ? (
                  <button type="button" className="secondary-button" onClick={() => onArchive(selectedProject)}>
                    <Archive size={14} />
                    {t('workshop.library.archive', '归档')}
                  </button>
                ) : (
                  <>
                    <button type="button" className="secondary-button" onClick={() => onRestore(selectedProject)}>
                      <ArrowCounterClockwise size={14} />
                      {t('workshop.library.restore', '恢复')}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => setPendingDeleteId(selectedProject.id)}>
                      <Trash size={14} />
                      {t('workshop.library.delete', '永久删除')}
                    </button>
                  </>
                )}
                {/* A project whose world was deleted stays usable; only entering the world is gone. */}
                {selectedProject.worldLinked ? (
                  <button type="button" className="primary-button" onClick={() => onOpenWorld(selectedProject.worldId)}>
                    {t('workshop.library.enterWorld', '进入世界')}
                    <ArrowRight size={14} />
                  </button>
                ) : null}
              </div>
            </header>

            {selectedProject.worldLinked ? null : (
              <div className="creative-workshop-project-detached" role="note">
                <WarningCircle size={16} />
                <div>
                  <strong>{t('workshop.library.detached', '关联世界已删除')}</strong>
                  <p>{t('workshop.library.detachedHint', '项目仍然保留，可基于它创建一个新的世界。')}</p>
                </div>
              </div>
            )}

            {pendingDeleteId === selectedProject.id ? (
              <div className="creative-workshop-project-delete-confirm" role="alertdialog" aria-label={t('workshop.library.delete', '永久删除')}>
                <p>{t('workshop.library.deleteConfirm', '永久删除这个项目？关联的世界仍然存在。')}</p>
                <div>
                  <button type="button" className="secondary-button" onClick={() => setPendingDeleteId(undefined)}>
                    {t('workshop.cancel', '取消')}
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => { setPendingDeleteId(undefined); onDelete(selectedProject) }}
                  >
                    {t('workshop.library.deleteConfirmAction', '确认永久删除')}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="creative-workshop-project-facts">
              <div><span>{t('workshop.library.template', '基础模板')}</span><strong>{selectedProject.baseTemplateId}</strong></div>
              <div><span>{t('workshop.library.roles', '角色')}</span><strong>{selectedProject.roles.length}</strong></div>
              <div><span>{t('workshop.library.packages', '生成包')}</span><strong>{selectedProject.generatedPackageIds.length}</strong></div>
              <div><span>{t('workshop.library.updated', '最近更新')}</span><strong>{formatDate(selectedProject.updatedAt, locale)}</strong></div>
            </div>

            <section className="creative-workshop-project-roles">
              <header>
                <UsersThree size={17} />
                <strong>{t('workshop.library.roleSkills', '角色与技能请求')}</strong>
              </header>
              <div>
                {selectedProject.roles.map((role) => (
                  <article key={role.id}>
                    <header>
                      <div>
                        <strong>{role.displayName}</strong>
                        <span>{role.role}</span>
                      </div>
                      <small>{role.embodiment.roleTags.join(' · ') || t('workshop.library.general', '通用')}</small>
                    </header>
                    <p>{role.summary}</p>
                    <div className="creative-workshop-project-skills">
                      {role.requestedSkillIds.length === 0 ? (
                        <span>{t('workshop.library.noExtraSkills', '未请求额外技能')}</span>
                      ) : (
                        role.requestedSkillIds.map((skillId) => (
                          <code key={skillId}>{skillNames.get(skillId) ?? skillId}</code>
                        ))
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="creative-workshop-project-storage">
              <strong>{t('workshop.library.localSaved', '本地保存')}</strong>
              <p>{t('workshop.library.localSavedDescription', '项目、角色包和世界数据均保存在当前设备。')}</p>
              <small>{t('workshop.library.updateNoOverwrite', '应用更新只替换程序，不会覆盖这个项目或对应世界。')}</small>
            </section>
          </>
        )}
      </main>
    </div>
  )
}

function formatDate(value: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value))
  } catch {
    return String(value)
  }
}
