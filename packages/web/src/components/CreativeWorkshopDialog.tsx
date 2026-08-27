import { X } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CreativeWorkshopDraftV1, WorldTemplateManifest } from '@dsh-cyber/contracts'
import type {
  CharacterSkillDescriptor,
  EmbodimentPresetDescriptor,
  WorkshopProject,
} from '@dsh-cyber/contracts/creative-platform'

import { api, ApiError } from '../api.js'
import { CreativeWorkshopEditor } from './creative-workshop/CreativeWorkshopEditor.js'
import { CreativeWorkshopProjectLibrary } from './creative-workshop/CreativeWorkshopProjectLibrary.js'
import { analyzeWorkshopPrompt } from './creative-workshop/prompt-parser.js'
import { portableDraftJson } from './creative-workshop/WorkshopJsonEditor.js'
import {
  createEmptyWorkshopDraft,
  draftToCreateInput,
  projectToDraft,
  validateWorkshopDraft,
  type WorkshopDraft,
} from './creative-workshop/model.js'
import './CreativeWorkshopDialog.css'

interface CreativeWorkshopDialogProps {
  workspaceId: string
  onClose(): void
  onCreated(project: WorkshopProject): void
  onOpenWorld?(worldId: string): void
}

type WorkshopView = 'library' | 'editor'

export function CreativeWorkshopDialog({ workspaceId, onClose, onCreated, onOpenWorld }: CreativeWorkshopDialogProps) {
  const [view, setView] = useState<WorkshopView>('library')
  const [projects, setProjects] = useState<WorkshopProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string>()
  const [templates, setTemplates] = useState<WorldTemplateManifest[]>([])
  const [skills, setSkills] = useState<CharacterSkillDescriptor[]>([])
  const [presets, setPresets] = useState<EmbodimentPresetDescriptor[]>([])
  const [draft, setDraft] = useState<WorkshopDraft>()
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [promptReply, setPromptReply] = useState<string>()
  const draftSaveTimer = useRef<number | undefined>(undefined)
  const latestDraft = useRef<WorkshopDraft | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void Promise.all([
      api<{ items: WorldTemplateManifest[] }>('/api/catalog/world-templates'),
      api<{ items: EmbodimentPresetDescriptor[] }>('/api/catalog/embodiment-presets'),
      api<{ items: CharacterSkillDescriptor[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/skill-catalog`),
      api<{ items: WorkshopProject[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/workshop/projects`),
      api<{ draft?: CreativeWorkshopDraftV1 }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/workshop/draft`),
    ]).then(([templateResult, presetResult, skillResult, projectResult, draftResult]) => {
      if (cancelled) return
      setTemplates(templateResult.items)
      setPresets(presetResult.items)
      setSkills(skillResult.items)
      setProjects(projectResult.items)
      setSelectedProjectId(projectResult.items[0]?.id)
      if (draftResult.draft !== undefined && presetResult.items.length > 0) {
        const restored = analyzeWorkshopPrompt(JSON.stringify(draftResult.draft), templateResult.items, presetResult.items).draft
        setDraft(restored)
        latestDraft.current = restored
        setPromptReply('已恢复上次未完成的本地草稿。')
        setView('editor')
      }
      setError(undefined)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : '创意工坊目录加载失败')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [workspaceId])

  useEffect(() => () => {
    if (draftSaveTimer.current !== undefined) window.clearTimeout(draftSaveTimer.current)
    const pending = latestDraft.current
    if (pending !== undefined) void saveDraft(workspaceId, pending).catch(() => undefined)
  }, [workspaceId])

  const changeDraft = (next: WorkshopDraft) => {
    setDraft(next)
    latestDraft.current = next
    if (draftSaveTimer.current !== undefined) window.clearTimeout(draftSaveTimer.current)
    draftSaveTimer.current = window.setTimeout(() => {
      void saveDraft(workspaceId, next).catch(() => setError('草稿自动保存失败，请检查本地服务后重试。'))
    }, 600)
  }

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId),
    [projects, selectedProjectId],
  )

  const startNew = (source?: WorkshopProject) => {
    const templateId = source?.baseTemplateId ?? templates[0]?.id ?? 'personal-world'
    const preset = presets[0]
    if (source === undefined && preset === undefined) {
      setError('当前宿主没有可用的具身语义预设，无法创建新角色')
      return
    }
    setDraft(source === undefined
      ? createEmptyWorkshopDraft(templateId, preset!)
      : projectToDraft(source, presets))
    setError(undefined)
    setPromptReply(undefined)
    setView('editor')
  }

  const analyzePrompt = async (input: string): Promise<void> => {
    if (draft === undefined) return
    try {
      const result = analyzeWorkshopPrompt(input, templates, presets, draft)
      changeDraft(result.draft)
      setPromptReply(`草稿已生成：1 个世界、${result.draft.roles.length} 个独立角色。所有内容尚未创建，请逐项检查后再确认。`)
      setError(undefined)
    } catch (cause) {
      setPromptReply(undefined)
      setError(cause instanceof Error ? cause.message : '提示词无法转换为世界草稿')
    }
  }

  const create = async () => {
    if (draft === undefined) return
    const validationError = validateWorkshopDraft(draft)
    if (validationError !== undefined) {
      setError(validationError)
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      const input = draftToCreateInput(draft)
      const result = await api<{ project: WorkshopProject }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/workshop/projects`, {
        method: 'POST',
        body: JSON.stringify(input),
      })
      setProjects((current) => [result.project, ...current.filter((project) => project.id !== result.project.id)])
      setSelectedProjectId(result.project.id)
      setView('library')
      setDraft(undefined)
      setPromptReply(undefined)
      latestDraft.current = undefined
      await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/workshop/draft`, { method: 'DELETE' }).catch(() => undefined)
      onCreated(result.project)
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === 'internal_error'
        ? '创意工坊创建失败，服务没有完成这次操作。请重试；如果持续失败，请打开系统状态查看详情。'
        : cause instanceof Error ? cause.message : '世界创建失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="creative-workshop-dialog" role="dialog" aria-modal="true" aria-labelledby="creative-workshop-title">
        <header className="dialog-header">
          <div>
            <h2 id="creative-workshop-title">创意工坊</h2>
            <p>用分步引导创建世界、初始角色和能力范围。项目与生成结果都保存在当前设备。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭创意工坊" onClick={onClose}><X size={18} /></button>
        </header>

        {loading ? (
          <div className="creative-workshop-loading">正在读取本地项目、世界模板和能力目录…</div>
        ) : view === 'editor' && draft !== undefined ? (
          <CreativeWorkshopEditor
            draft={draft}
            templates={templates}
            presets={presets}
            skills={skills}
            saving={saving}
            {...(error === undefined ? {} : { error })}
            {...(promptReply === undefined ? {} : { promptReply })}
            onChange={changeDraft}
            onAnalyzePrompt={analyzePrompt}
            onBack={() => { setView('library'); setDraft(undefined); setPromptReply(undefined); setError(undefined) }}
            onSubmit={() => void create()}
          />
        ) : (
          <>
            {error === undefined ? null : <div className="creative-workshop-error" role="alert">{error}</div>}
            <CreativeWorkshopProjectLibrary
              projects={projects}
              {...(selectedProject === undefined ? {} : { selectedProject })}
              skills={skills}
              onSelect={(project) => setSelectedProjectId(project.id)}
              onCreate={() => startNew()}
              onDuplicate={startNew}
              onOpenWorld={(worldId) => {
                if (onOpenWorld !== undefined) onOpenWorld(worldId)
                else onClose()
              }}
            />
          </>
        )}
      </section>
    </div>
  )
}

async function saveDraft(workspaceId: string, draft: WorkshopDraft): Promise<void> {
  await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/workshop/draft`, {
    method: 'PUT',
    body: portableDraftJson(draft),
  })
}
