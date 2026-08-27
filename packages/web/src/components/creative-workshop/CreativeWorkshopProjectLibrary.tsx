import { ArrowRight, Copy, Cube, Plus, UsersThree } from '@phosphor-icons/react'
import type { CharacterSkillDescriptor, WorkshopProject } from '@dsh-cyber/contracts/creative-platform'

import { useI18n } from '../../i18n/runtime.js'
import './CreativeWorkshopProjectLibrary.css'

interface CreativeWorkshopProjectLibraryProps {
  projects: WorkshopProject[]
  selectedProject?: WorkshopProject
  skills: CharacterSkillDescriptor[]
  onSelect(project: WorkshopProject): void
  onCreate(): void
  onDuplicate(project: WorkshopProject): void
  onOpenWorld(worldId: string): void
}

export function CreativeWorkshopProjectLibrary({
  projects,
  selectedProject,
  skills,
  onSelect,
  onCreate,
  onDuplicate,
  onOpenWorld,
}: CreativeWorkshopProjectLibraryProps) {
  const { locale, t } = useI18n()
  const skillNames = new Map(skills.map((skill) => [skill.id, skill.displayName]))

  return (
    <div className="creative-workshop-library">
      <aside className="creative-workshop-project-list">
        <header>
          <div><strong>{t('workshop.library.title', '我的本地项目')}</strong><small>{t('workshop.library.count', '{count} 个世界项目', { count: projects.length })}</small></div>
          <button type="button" className="primary-button" onClick={onCreate}><Plus size={14} />{t('workshop.library.new', '新建')}</button>
        </header>
        {projects.length === 0 ? (
          <div className="creative-workshop-library-empty">
            <Cube size={30} />
            <strong>{t('workshop.library.emptyTitle', '还没有本地创意项目')}</strong>
            <p>{t('workshop.library.emptyDescription', '跟随四步引导选择世界模板、创建角色并配置能力。项目保存在本机，不会随程序升级消失。')}</p>
            <button type="button" className="primary-button" onClick={onCreate}>{t('workshop.library.firstWorld', '创建第一个世界')}</button>
          </div>
        ) : (
          <div className="creative-workshop-project-items">
            {projects.map((project) => (
              <button key={project.id} type="button" className={selectedProject?.id === project.id ? 'is-active' : ''} onClick={() => onSelect(project)}>
                <span className="creative-workshop-project-icon"><Cube size={17} /></span>
                <span><strong>{project.displayName}</strong><small>{t('workshop.library.roleCount', '{count} 个角色', { count: project.roles.length })} · {formatDate(project.updatedAt, locale)}</small></span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className="creative-workshop-project-detail">
        {selectedProject === undefined ? (
          <div className="creative-workshop-project-placeholder">
            <Cube size={34} />
            <strong>{projects.length === 0 ? t('workshop.library.firstWorld', '创建你的第一个本地世界') : t('workshop.library.select', '选择一个项目查看详情')}</strong>
            <p>{t('workshop.library.worldSaved', '世界设置、角色和生成内容都保存在当前设备。')}</p>
          </div>
        ) : (
          <>
            <header className="creative-workshop-project-detail__header">
              <div><span>{t('workshop.library.localProject', '本地世界项目')}</span><h3>{selectedProject.displayName}</h3><p>{selectedProject.scenario || selectedProject.lore || t('workshop.library.scenarioEmpty', '尚未填写世界说明。')}</p></div>
              <div>
                <button type="button" className="secondary-button" onClick={() => onDuplicate(selectedProject)}><Copy size={14} />{t('workshop.library.duplicate', '基于此项目创建副本')}</button>
                <button type="button" className="primary-button" onClick={() => onOpenWorld(selectedProject.worldId)}>{t('workshop.library.enterWorld', '进入世界')}<ArrowRight size={14} /></button>
              </div>
            </header>

            <div className="creative-workshop-project-facts">
              <div><span>{t('workshop.library.template', '基础模板')}</span><strong>{selectedProject.baseTemplateId}</strong></div>
              <div><span>{t('workshop.library.roles', '角色')}</span><strong>{selectedProject.roles.length}</strong></div>
              <div><span>{t('workshop.library.packages', '生成包')}</span><strong>{selectedProject.generatedPackageIds.length}</strong></div>
              <div><span>{t('workshop.library.updated', '最近更新')}</span><strong>{formatDate(selectedProject.updatedAt, locale)}</strong></div>
            </div>

            <section className="creative-workshop-project-roles">
              <header><UsersThree size={17} /><strong>{t('workshop.library.roleSkills', '角色与技能请求')}</strong></header>
              <div>
                {selectedProject.roles.map((role) => (
                  <article key={role.id}>
                    <header><div><strong>{role.displayName}</strong><span>{role.role}</span></div><small>{role.embodiment.roleTags.join(' · ') || t('workshop.library.general', '通用')}</small></header>
                    <p>{role.summary}</p>
                    <div className="creative-workshop-project-skills">
                      {role.requestedSkillIds.length === 0
                        ? <span>{t('workshop.library.noExtraSkills', '未请求额外技能')}</span>
                        : role.requestedSkillIds.map((skillId) => <code key={skillId}>{skillNames.get(skillId) ?? skillId}</code>)}
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
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}
