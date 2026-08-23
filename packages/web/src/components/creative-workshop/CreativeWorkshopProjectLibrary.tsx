import { ArrowRight, Copy, Cube, Plus, UsersThree } from '@phosphor-icons/react'
import type { CharacterSkillDescriptor, WorkshopProject } from '@dsh-cyber/contracts/creative-platform'

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
  const skillNames = new Map(skills.map((skill) => [skill.id, skill.displayName]))

  return (
    <div className="creative-workshop-library">
      <aside className="creative-workshop-project-list">
        <header>
          <div><strong>我的本地项目</strong><small>{projects.length} 个世界项目</small></div>
          <button type="button" className="primary-button" onClick={onCreate}><Plus size={14} />新建</button>
        </header>
        {projects.length === 0 ? (
          <div className="creative-workshop-library-empty">
            <Cube size={30} />
            <strong>还没有本地创意项目</strong>
            <p>从一个基础世界模板开始，定义世界观、角色与 Skill 请求。项目会保存在本机，不随程序升级消失。</p>
            <button type="button" className="primary-button" onClick={onCreate}>创建第一个世界</button>
          </div>
        ) : (
          <div className="creative-workshop-project-items">
            {projects.map((project) => (
              <button key={project.id} type="button" className={selectedProject?.id === project.id ? 'is-active' : ''} onClick={() => onSelect(project)}>
                <span className="creative-workshop-project-icon"><Cube size={17} /></span>
                <span><strong>{project.displayName}</strong><small>{project.roles.length} 个角色 · {formatDate(project.updatedAt)}</small></span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className="creative-workshop-project-detail">
        {selectedProject === undefined ? (
          <div className="creative-workshop-project-placeholder">
            <Cube size={34} />
            <strong>{projects.length === 0 ? '创建你的第一个本地世界' : '选择一个项目查看详情'}</strong>
            <p>项目源、生成的角色包和世界数据都保存在本地 `stateRoot`。</p>
          </div>
        ) : (
          <>
            <header className="creative-workshop-project-detail__header">
              <div><span>本地世界项目</span><h3>{selectedProject.displayName}</h3><p>{selectedProject.scenario || selectedProject.lore || '尚未填写世界说明。'}</p></div>
              <div>
                <button type="button" className="secondary-button" onClick={() => onDuplicate(selectedProject)}><Copy size={14} />基于此项目创建副本</button>
                <button type="button" className="primary-button" onClick={() => onOpenWorld(selectedProject.worldId)}>进入世界<ArrowRight size={14} /></button>
              </div>
            </header>

            <div className="creative-workshop-project-facts">
              <div><span>基础模板</span><strong>{selectedProject.baseTemplateId}</strong></div>
              <div><span>角色</span><strong>{selectedProject.roles.length}</strong></div>
              <div><span>生成包</span><strong>{selectedProject.generatedPackageIds.length}</strong></div>
              <div><span>最近更新</span><strong>{formatDate(selectedProject.updatedAt)}</strong></div>
            </div>

            <section className="creative-workshop-project-roles">
              <header><UsersThree size={17} /><strong>角色与能力请求</strong></header>
              <div>
                {selectedProject.roles.map((role) => (
                  <article key={role.id}>
                    <header><div><strong>{role.displayName}</strong><span>{role.role}</span></div><small>{role.embodiment.roleTags.join(' · ') || 'general'}</small></header>
                    <p>{role.summary}</p>
                    <div className="creative-workshop-project-skills">
                      {role.requestedSkillIds.length === 0
                        ? <span>未请求额外 Skill</span>
                        : role.requestedSkillIds.map((skillId) => <code key={skillId}>{skillNames.get(skillId) ?? skillId}</code>)}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <section className="creative-workshop-project-storage">
              <strong>本地持久化</strong>
              <p><code>workshop/projects/{selectedProject.id}/project.json</code></p>
              <small>源码更新只替换程序；这个项目和对应世界仍由当前 `stateRoot` 持有。</small>
            </section>
          </>
        )}
      </main>
    </div>
  )
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
