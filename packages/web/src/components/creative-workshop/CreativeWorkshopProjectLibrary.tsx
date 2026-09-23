import { ArrowRight, Cube, Plus, ShieldCheck, SlidersHorizontal, UsersThree } from '@phosphor-icons/react'
import type { ReactNode } from 'react'
import type { SkillCatalogEntry, WorldTemplateManifest } from '@dsh-cyber/contracts'
import type { WorkshopProjectView } from '@dsh-cyber/contracts/creative-platform'

import { useI18n } from '../../i18n/runtime.js'
import { mcpServiceOfSkillId } from '../mcp-skill-grouping.js'
import './CreativeWorkshopProjectLibrary.css'

interface CreativeWorkshopProjectLibraryProps {
  projects: WorkshopProjectView[]
  templates?: WorldTemplateManifest[]
  selectedProject?: WorkshopProjectView
  skills: SkillCatalogEntry[]
  notice?: string
  onSelect(project: WorkshopProjectView): void
  onCreate(templateId?: string): void
  onDuplicate(project: WorkshopProjectView): void
  onOpenWorld(worldId: string): void
  onArchive(project: WorkshopProjectView): void
  onRestore(project: WorkshopProjectView): void
  onDelete(project: WorkshopProjectView): void
}

export function CreativeWorkshopProjectLibrary({ templates = [], onCreate }: CreativeWorkshopProjectLibraryProps) {
  const { t } = useI18n()
  return (
      <div className="creative-workshop-hub">

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

export function skillChipsForRole(
  requestedIds: readonly string[],
  skillNames: ReadonlyMap<string, string>,
  serviceLabels: ReadonlyMap<string, string>,
  skillPackages: ReadonlyMap<string, { id: string; label: string }> = new Map(),
): ReactNode[] {
  const plainIds: string[] = []
  const toolsByService = new Map<string, string[]>()
  const packageIds = new Map<string, string[]>()
  for (const skillId of requestedIds) {
    const service = mcpServiceOfSkillId(skillId)
    const packageInfo = skillPackages.get(skillId)
    if (service !== undefined) toolsByService.set(service, [...(toolsByService.get(service) ?? []), skillId])
    else if (packageInfo !== undefined) {
      packageIds.set(packageInfo.id, [...(packageIds.get(packageInfo.id) ?? []), skillId])
    } else plainIds.push(skillId)
  }
  const chips: ReactNode[] = plainIds.map((skillId) => <code key={skillId}>{skillNames.get(skillId) ?? skillId}</code>)
  for (const [packageId, memberIds] of [...packageIds.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const label = skillPackages.get(memberIds[0]!)?.label ?? packageId
    chips.push(<code key={`skill-package-${packageId}`}>{memberIds.length === 1 ? label : `${label}（${memberIds.length} 项能力）`}</code>)
  }
  for (const [service, toolIds] of [...toolsByService.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const label = serviceLabels.get(service) ?? service
    const title = toolIds.length === 1
      ? `MCP · ${label} / ${toolNameOfToolId(toolIds[0]!, service)}`
      : `MCP · ${label}（${toolIds.length} 个工具）`
    chips.push(<code key={`mcp-service-${service}`}>{title}</code>)
  }
  return chips
}

function toolNameOfToolId(skillId: string, service: string): string {
  return skillId.slice(`mcp.${service}.`.length)
}
