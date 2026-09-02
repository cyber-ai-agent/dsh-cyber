import { ArrowLeft, Info } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CharacterBlueprintDraft, CharacterSourceInput, WorldGeneratorCatalog, WorldGeneratorSceneCatalogItem, WorldGeneratorSceneSelection, WorldThemeDraft } from '@dsh-cyber/contracts'
import { useI18n } from '../../i18n/runtime.js'
import { SourceStep } from '../character-generator/CharacterGeneratorSteps.js'
import { CHARACTER_SOURCE_MAX_BYTES } from '../character-generator/model.js'
import { analyzeWorldSource, loadWorldGeneratorCatalog, publishWorldDraft } from './api.js'
import { WorldAnalysisStep, WorldPreviewStep, WorldPublishStep } from './WorldGeneratorSteps.js'
import {
  EMPTY_WORLD_CATALOG,
  defaultSceneSelection,
  emptyCastMember,
  initialWorldDraft,
  trimWorldDraft,
  validateWorldDraft,
  validateWorldSource,
  type WorldGeneratorProps,
  type WorldGeneratorStep,
} from './model.js'
import '../character-generator/CharacterGenerator.css'
import './WorldGenerator.css'

/**
 * 世界 → 自定义世界. The second generator, built on the Character Generator's
 * product pattern: 来源 → AI 分析 → 预览编辑 → 显式发布. Publish produces a
 * world-theme package plus a cast of talent packages in the workspace's own
 * generated marketplace; nothing is installed, created or recruited here.
 */
export function WorldGenerator({ workspaceId, onClose, onPublished, closeRequest = 0 }: WorldGeneratorProps) {
  const { t } = useI18n()
  const viewRef = useRef<HTMLDivElement>(null)
  const discardRef = useRef<HTMLDivElement>(null)
  const discardReturnFocusRef = useRef<HTMLElement | undefined>(undefined)
  const activeRequestRef = useRef<AbortController | undefined>(undefined)
  const lastCloseRequestRef = useRef(closeRequest)
  const [step, setStep] = useState<WorldGeneratorStep>('source')
  const [source, setSource] = useState<CharacterSourceInput>({ kind: 'description', text: '' })
  const [sourceError, setSourceError] = useState<string>()
  const [catalog, setCatalog] = useState<WorldGeneratorCatalog>(() => EMPTY_WORLD_CATALOG)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState<string>()
  const [catalogRetry, setCatalogRetry] = useState(0)
  const [draft, setDraft] = useState<WorldThemeDraft>()
  const [scene, setScene] = useState<WorldGeneratorSceneSelection>()
  const [suggestedScene, setSuggestedScene] = useState<string>()
  const [analysisError, setAnalysisError] = useState<string>()
  const [analyzing, setAnalyzing] = useState(false)
  const [validationError, setValidationError] = useState<string>()
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string>()
  const [publishedResult, setPublishedResult] = useState<Parameters<WorldGeneratorProps['onPublished']>[0]>()
  const [discardPrompt, setDiscardPrompt] = useState(false)
  const dirty = publishedResult === undefined && (source.text.trim().length > 0 || draft !== undefined)

  useEffect(() => {
    if (scene !== undefined && catalog.scenes.some((option) => option.id === scene.id)) return
    setScene(defaultSceneSelection(catalog, suggestedScene))
  }, [catalog, scene, suggestedScene])

  useEffect(() => {
    const controller = new AbortController()
    setCatalogLoading(true)
    setCatalogError(undefined)
    void loadWorldGeneratorCatalog(workspaceId, controller.signal)
      .then((nextCatalog) => setCatalog(nextCatalog))
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return
        setCatalogError(cause instanceof Error ? cause.message : t('worldGenerator.catalogError', '目录读取失败。仍可编辑世界资料，场景、技能和能力会在目录恢复后显示。'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false)
      })
    return () => controller.abort()
  }, [catalogRetry, t, workspaceId])

  useEffect(() => {
    viewRef.current?.querySelector<HTMLElement>('[data-generator-initial-focus]')?.focus()
  }, [step])

  useEffect(() => {
    if (closeRequest === lastCloseRequestRef.current) return
    lastCloseRequestRef.current = closeRequest
    requestClose()
  })

  useEffect(() => () => activeRequestRef.current?.abort(), [])

  const requestClose = () => {
    if (dirty) {
      if (!discardPrompt) discardReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      setDiscardPrompt(true)
      return
    }
    activeRequestRef.current?.abort()
    onClose()
  }

  const keepEditing = useCallback(() => {
    setDiscardPrompt(false)
    const restore = discardReturnFocusRef.current
    discardReturnFocusRef.current = undefined
    if (restore?.isConnected === true) restore.focus()
  }, [])

  const discard = () => {
    activeRequestRef.current?.abort()
    discardReturnFocusRef.current = undefined
    setDiscardPrompt(false)
    onClose()
  }

  // Same modal contract as the Character Generator's discard prompt: focus on
  // the non-destructive option, Tab trapped, Escape means keep editing.
  useEffect(() => {
    if (!discardPrompt) return
    const container = discardRef.current
    if (container === null) return
    const focusable = () => [...container.querySelectorAll<HTMLElement>('button:not([disabled])')]
    focusable()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        keepEditing()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]!
      const last = items.at(-1)!
      if (!container.contains(document.activeElement)) { event.preventDefault(); first.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [discardPrompt, keepEditing])

  const handleSource = (value: string) => {
    setSource((current) => current.kind === 'file' && current.fileName !== undefined ? { kind: 'file', text: value, fileName: current.fileName } : { kind: current.kind, text: value })
    setSourceError(undefined)
    setAnalysisError(undefined)
    setPublishError(undefined)
  }

  const handleSourceFile = async (file: File) => {
    const extension = file.name.toLowerCase().split('.').pop()
    const validType = file.type === 'text/plain' || file.type === 'text/markdown' || extension === 'md' || extension === 'txt'
    if (!validType) {
      setSourceError(t('characterGenerator.sourceFileInvalid', '仅支持 Markdown 或纯文本文件。'))
      return
    }
    if (file.size > CHARACTER_SOURCE_MAX_BYTES) {
      setSourceError(t('characterGenerator.sourceTooLarge', '描述不能超过 128 KiB。'))
      return
    }
    try {
      setSource({ kind: 'file', text: await file.text(), fileName: file.name })
      setSourceError(undefined)
      setAnalysisError(undefined)
      setPublishError(undefined)
    } catch {
      setSourceError(t('characterGenerator.sourceFileInvalid', '仅支持 Markdown 或纯文本文件。'))
    }
  }

  const analyze = () => {
    const sourceErrorKey = validateWorldSource(source)
    if (sourceErrorKey !== undefined) {
      setSourceError(sourceErrorMessage(sourceErrorKey, t))
      return
    }
    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller
    setAnalyzing(true)
    setAnalysisError(undefined)
    setValidationError(undefined)
    setPublishError(undefined)
    setStep('analysis')
    void analyzeWorldSource(workspaceId, source, catalog.targetWorldTemplateId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setDraft(result.draft)
        setSuggestedScene(result.suggestedSceneId)
        if (result.suggestedSceneId !== undefined) setScene({ kind: 'official', id: result.suggestedSceneId })
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return
        setAnalysisError(cause instanceof Error ? cause.message : t('characterGenerator.analysisError', '分析没有完成。来源和已生成内容仍然保留。'))
      })
      .finally(() => {
        if (activeRequestRef.current === controller) {
          activeRequestRef.current = undefined
          setAnalyzing(false)
        }
      })
  }

  const cancelAnalysis = () => {
    activeRequestRef.current?.abort()
    activeRequestRef.current = undefined
    setAnalyzing(false)
    setStep('source')
  }

  const updateDraft = (patch: Partial<WorldThemeDraft>) => {
    setDraft((current) => current === undefined ? current : { ...current, ...patch })
    setValidationError(undefined)
    setPublishError(undefined)
  }

  const updateCast = (index: number, patch: Partial<CharacterBlueprintDraft>) => {
    setDraft((current) => current === undefined ? current : { ...current, cast: current.cast.map((member, position) => position === index ? { ...member, ...patch } : member) })
    setValidationError(undefined)
    setPublishError(undefined)
  }

  const addCast = () => updateDraft({ cast: [...(draft?.cast ?? []), emptyCastMember(catalog.targetWorldTemplateId)] })
  const removeCast = (index: number) => updateDraft({ cast: (draft?.cast ?? []).filter((_, position) => position !== index) })
  const selectScene = (option: WorldGeneratorSceneCatalogItem) => setScene({ kind: 'official', id: option.id })

  const continueToPublish = () => {
    if (draft === undefined) return
    const nextDraft = trimWorldDraft(draft)
    const errorKey = validateWorldDraft(nextDraft, catalog)
    if (errorKey !== undefined) {
      setValidationError(draftErrorMessage(errorKey, t))
      return
    }
    setDraft(nextDraft)
    setValidationError(undefined)
    setPublishError(undefined)
    setStep('publish')
  }

  const publish = () => {
    if (draft === undefined) return
    const nextDraft = trimWorldDraft(draft)
    const errorKey = validateWorldDraft(nextDraft, catalog)
    if (errorKey !== undefined) {
      setValidationError(draftErrorMessage(errorKey, t))
      setStep('preview')
      return
    }
    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller
    setPublishing(true)
    setPublishError(undefined)
    void publishWorldDraft(workspaceId, source, nextDraft, scene, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setDraft(nextDraft)
        setPublishedResult(result)
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return
        setPublishError(cause instanceof Error ? cause.message : t('characterGenerator.publishError', '发布失败。草稿仍然保留，可以修改后重试。'))
      })
      .finally(() => {
        if (activeRequestRef.current === controller) {
          activeRequestRef.current = undefined
          setPublishing(false)
        }
      })
  }

  const viewInstall = () => {
    if (publishedResult === undefined) return
    void Promise.resolve(onPublished(publishedResult)).catch((cause: unknown) => setPublishError(cause instanceof Error ? cause.message : t('characterGenerator.publishError', '发布失败。草稿仍然保留，可以修改后重试。')))
  }

  const stepLabels: Array<{ id: WorldGeneratorStep; label: string }> = [
    { id: 'source', label: t('characterGenerator.stepSource', '创建方式') },
    { id: 'analysis', label: t('characterGenerator.stepAnalysis', 'AI 分析') },
    { id: 'preview', label: t('characterGenerator.stepPreview', '预览编辑') },
    { id: 'publish', label: t('worldGenerator.stepPublish', '发布世界') },
  ]
  const selectedScene = scene === undefined ? undefined : catalog.scenes.find((option) => option.id === scene.id)
  const sourceCopy = {
    intro: t('worldGenerator.sourceIntro', '从一段场景描述开始'),
    hint: t('worldGenerator.sourceHint', '描述你需要的场景：它是什么地方、谁在里面、按什么流程工作、有哪些规矩。支持 Markdown 或纯文本。'),
    label: t('worldGenerator.sourceLabel', '世界描述'),
    placeholder: t('worldGenerator.sourcePlaceholder', '例如：一家社区法律援助诊所，律师、助理和志愿者分工接待来访者、梳理问题、准备材料并转介。'),
    safety: t('worldGenerator.sourceSafety', '来源内容是不可信数据。分析结果需要你逐项检查后才会生成世界主题包。'),
  }

  return (
    <div ref={viewRef} className="character-generator world-generator">
      <ol className="character-generator__steps" aria-label={t('characterGenerator.stepSource', '创建方式')}>
        {stepLabels.map((item, index) => <li key={item.id} className={step === item.id ? 'is-current' : ''} aria-current={step === item.id ? 'step' : undefined}><span>{index + 1}</span><strong>{item.label}</strong></li>)}
      </ol>
      {catalogLoading ? <div className="character-generator-catalog-status" role="status">{t('worldGenerator.catalogLoading', '正在读取官方场景与可用目录…')}</div> : catalogError === undefined ? null : <div className="character-generator-catalog-status is-error" role="alert"><Info size={16} aria-hidden="true" /><span>{catalogError}</span><button className="text-button" type="button" onClick={() => setCatalogRetry((value) => value + 1)}>{t('characterGenerator.retryCatalog', '重试读取目录')}</button></div>}
      <main className="character-generator__body">
        {step === 'source' ? <SourceStep sourceMode={source.kind} source={source.text} {...(source.fileName === undefined ? {} : { sourceFileName: source.fileName })} {...(sourceError === undefined ? {} : { error: sourceError })} analyzing={analyzing} copy={sourceCopy} onSourceMode={(kind) => setSource((current) => kind === 'file' ? { kind, text: current.text, ...(current.fileName === undefined ? {} : { fileName: current.fileName }) } : { kind, text: current.text })} onSource={handleSource} onFile={(file) => void handleSourceFile(file)} onAnalyze={analyze} /> : step === 'analysis' ? <WorldAnalysisStep source={source.text} {...(draft === undefined ? {} : { draft })} analyzing={analyzing} {...(analysisError === undefined ? {} : { error: analysisError })} onCancel={cancelAnalysis} onRetry={analyze} onContinue={() => { if (draft !== undefined) { setStep('preview'); setValidationError(undefined) } }} /> : step === 'preview' && draft !== undefined ? <WorldPreviewStep draft={draft} catalog={catalog} {...(scene === undefined ? {} : { scene })} {...(validationError === undefined ? {} : { validationError })} onDraftChange={updateDraft} onSceneSelect={selectScene} onCastChange={updateCast} onCastAdd={addCast} onCastRemove={removeCast} onBack={() => { setStep('analysis'); setValidationError(undefined) }} onContinue={continueToPublish} /> : <WorldPublishStep draft={draft ?? initialWorldDraft(catalog.targetWorldTemplateId)} source={source.text} {...(selectedScene === undefined ? {} : { scene: selectedScene })} publishing={publishing} {...(publishError === undefined ? {} : { error: publishError })} published={publishedResult !== undefined} onBack={() => { setStep('preview'); setPublishError(undefined) }} onPublish={publish} onViewInstall={viewInstall} />}
      </main>
      {discardPrompt ? (
        <div ref={discardRef} className="character-generator-discard" role="alertdialog" aria-modal="true" aria-labelledby="world-generator-discard-title" aria-describedby="world-generator-discard-description">
          <strong id="world-generator-discard-title">{t('worldGenerator.discardTitle', '放弃未保存的世界草稿？')}</strong>
          <span id="world-generator-discard-description">{t('characterGenerator.discardDescription', '返回市场会丢弃当前来源和编辑内容。')}</span>
          <div>
            <button className="secondary-button" type="button" onClick={keepEditing}>{t('characterGenerator.keepEditing', '继续编辑')}</button>
            <button className="danger-button" type="button" onClick={discard}>{t('characterGenerator.discard', '放弃草稿')}</button>
          </div>
        </div>
      ) : null}
      {step !== 'source' && publishedResult === undefined ? <button className="character-generator__back-link" type="button" onClick={requestClose}><ArrowLeft size={15} aria-hidden="true" />{t('worldGenerator.back', '返回世界市场')}</button> : null}
    </div>
  )
}

function sourceErrorMessage(key: string, t: ReturnType<typeof useI18n>['t']): string {
  if (key === 'source.tooLarge') return t('characterGenerator.sourceTooLarge', '描述不能超过 128 KiB。')
  if (key === 'source.fileInvalid') return t('characterGenerator.sourceFileInvalid', '仅支持 Markdown 或纯文本文件。')
  return t('worldGenerator.sourceEmpty', '请先输入世界描述。')
}

function draftErrorMessage(key: string, t: ReturnType<typeof useI18n>['t']): string {
  const messages: Record<string, [string, string]> = {
    'draft.displayNameRequired': ['worldGenerator.requiredName', '请输入世界名称。'],
    'draft.summaryRequired': ['worldGenerator.requiredSummary', '请输入世界简介。'],
    'draft.terminologyRequired': ['worldGenerator.requiredTerminology', '请填写全部四个世界术语。'],
    'draft.castTooLarge': ['worldGenerator.castTooLarge', '默认角色不能超过 8 名。'],
    'draft.castDuplicate': ['worldGenerator.castDuplicate', '默认角色的名字不能重复。'],
    'cast.draft.displayNameRequired': ['worldGenerator.castRequiredName', '每名默认角色都需要名字。'],
    'cast.draft.roleRequired': ['worldGenerator.castRequiredRole', '每名默认角色都需要岗位或身份。'],
    'cast.draft.summaryRequired': ['worldGenerator.castRequiredSummary', '每名默认角色都需要简介。'],
    'cast.draft.personaRequired': ['worldGenerator.castRequiredPersona', '每名默认角色都需要 Persona 与行为方式。'],
    'cast.draft.skillUnavailable': ['characterGenerator.unavailableSkill', '草稿包含当前目录中不可用的技能。'],
    'cast.draft.capabilityUnavailable': ['characterGenerator.unavailableCapability', '草稿包含当前目录中不可用的能力。'],
  }
  const [messageKey, fallback] = messages[key] ?? ['characterGenerator.fieldTooLong', '内容超过允许长度。']
  return t(messageKey, fallback)
}

function isAbortError(cause: unknown): boolean {
  return (cause instanceof DOMException && cause.name === 'AbortError') || (cause instanceof Error && cause.name === 'AbortError')
}
