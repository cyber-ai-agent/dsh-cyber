import { ArrowLeft, Info } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CharacterSourceInput, PluginDraft, PluginGeneratorCatalog, PluginTransformDraft } from '@dsh-cyber/contracts'
import { useI18n } from '../../i18n/runtime.js'
import { SourceStep } from '../character-generator/CharacterGeneratorSteps.js'
import { CHARACTER_SOURCE_MAX_BYTES } from '../character-generator/model.js'
import { analyzePluginSource, loadPluginGeneratorCatalog, publishPluginDraft } from './api.js'
import { PluginAnalysisStep, PluginPreviewStep, PluginPublishStep } from './PluginGeneratorSteps.js'
import {
  EMPTY_PLUGIN_CATALOG,
  emptyTransform,
  initialPluginDraft,
  normalizeTrigger,
  reservedTriggerOwner,
  transformIssue,
  trimPluginDraft,
  validatePluginDraft,
  validatePluginSource,
  type PluginGeneratorProps,
  type PluginGeneratorStep,
} from './model.js'
import '../character-generator/CharacterGenerator.css'
import './PluginGenerator.css'

/**
 * 插件 → 自定义插件. The fourth generator, built on the Character Generator's
 * product pattern: 来源 → AI 分析 → 预览编辑 → 显式发布. Publish produces a
 * declaration-only plugin package in the workspace's own generated
 * marketplace; nothing is installed or enabled here.
 */
export function PluginGenerator({ workspaceId, onClose, onPublished, closeRequest = 0 }: PluginGeneratorProps) {
  const { t } = useI18n()
  const viewRef = useRef<HTMLDivElement>(null)
  const discardRef = useRef<HTMLDivElement>(null)
  const discardReturnFocusRef = useRef<HTMLElement | undefined>(undefined)
  const activeRequestRef = useRef<AbortController | undefined>(undefined)
  const lastCloseRequestRef = useRef(closeRequest)
  const [step, setStep] = useState<PluginGeneratorStep>('source')
  const [source, setSource] = useState<CharacterSourceInput>({ kind: 'description', text: '' })
  const [sourceError, setSourceError] = useState<string>()
  const [catalog, setCatalog] = useState<PluginGeneratorCatalog>(() => EMPTY_PLUGIN_CATALOG)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState<string>()
  const [catalogRetry, setCatalogRetry] = useState(0)
  const [draft, setDraft] = useState<PluginDraft>()
  const [analysisError, setAnalysisError] = useState<string>()
  const [analyzing, setAnalyzing] = useState(false)
  const [validationError, setValidationError] = useState<string>()
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string>()
  const [publishedResult, setPublishedResult] = useState<Parameters<PluginGeneratorProps['onPublished']>[0]>()
  const [discardPrompt, setDiscardPrompt] = useState(false)
  const dirty = publishedResult === undefined && (source.text.trim().length > 0 || draft !== undefined)

  useEffect(() => {
    const controller = new AbortController()
    setCatalogLoading(true)
    setCatalogError(undefined)
    void loadPluginGeneratorCatalog(workspaceId, controller.signal)
      .then((nextCatalog) => setCatalog(nextCatalog))
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return
        setCatalogError(cause instanceof Error ? cause.message : t('pluginGenerator.catalogError', '规则读取失败。仍可编辑指令，官方触发词冲突会在发布时检查。'))
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
    const sourceErrorKey = validatePluginSource(source)
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
    void analyzePluginSource(workspaceId, source, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setDraft(result.draft)
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

  const clearReviewErrors = () => {
    setValidationError(undefined)
    setPublishError(undefined)
  }

  const updateDraft = (patch: Partial<PluginDraft>) => {
    setDraft((current) => current === undefined ? current : { ...current, ...patch })
    clearReviewErrors()
  }

  const updateTransform = (index: number, patch: Partial<PluginTransformDraft>) => {
    setDraft((current) => current === undefined ? current : { ...current, transforms: current.transforms.map((transform, candidate) => candidate === index ? { ...transform, ...patch } : transform) })
    clearReviewErrors()
  }

  const addTransform = () => {
    setDraft((current) => current === undefined || current.transforms.length >= catalog.limits.maxTransforms ? current : { ...current, transforms: [...current.transforms, emptyTransform()] })
    clearReviewErrors()
  }

  const removeTransform = (index: number) => {
    setDraft((current) => current === undefined ? current : { ...current, transforms: current.transforms.filter((_, candidate) => candidate !== index) })
    clearReviewErrors()
  }

  const continueToPublish = () => {
    if (draft === undefined) return
    const nextDraft = trimPluginDraft(draft)
    const errorKey = validatePluginDraft(nextDraft, catalog)
    if (errorKey !== undefined) {
      setValidationError(draftErrorMessage(errorKey, nextDraft, catalog, t))
      return
    }
    setDraft(nextDraft)
    setValidationError(undefined)
    setPublishError(undefined)
    setStep('publish')
  }

  const publish = () => {
    if (draft === undefined) return
    const nextDraft = trimPluginDraft(draft)
    const errorKey = validatePluginDraft(nextDraft, catalog)
    if (errorKey !== undefined) {
      setValidationError(draftErrorMessage(errorKey, nextDraft, catalog, t))
      setStep('preview')
      return
    }
    activeRequestRef.current?.abort()
    const controller = new AbortController()
    activeRequestRef.current = controller
    setPublishing(true)
    setPublishError(undefined)
    void publishPluginDraft(workspaceId, source, nextDraft, controller.signal)
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

  const stepLabels: Array<{ id: PluginGeneratorStep; label: string }> = [
    { id: 'source', label: t('characterGenerator.stepSource', '创建方式') },
    { id: 'analysis', label: t('characterGenerator.stepAnalysis', 'AI 分析') },
    { id: 'preview', label: t('characterGenerator.stepPreview', '预览编辑') },
    { id: 'publish', label: t('pluginGenerator.stepPublish', '发布插件') },
  ]
  const sourceCopy = {
    intro: t('pluginGenerator.sourceIntro', '从一段提示词配方开始'),
    hint: t('pluginGenerator.sourceHint', '描述你想要的会话指令：什么时候输入、助手应该怎么做、输出什么结构。支持 Markdown 或纯文本。'),
    label: t('pluginGenerator.sourceLabel', '提示词配方'),
    placeholder: t('pluginGenerator.sourcePlaceholder', '例如：输入 /weekly-review 时，只依据当前会话的事实，按进展、阻碍、下周计划三段整理本周复盘。'),
    safety: t('pluginGenerator.sourceSafety', '来源内容是不可信数据。分析结果需要你逐条检查后才会生成插件包。'),
  }

  return (
    <div ref={viewRef} className="character-generator plugin-generator">
      <ol className="character-generator__steps" aria-label={t('characterGenerator.stepSource', '创建方式')}>
        {stepLabels.map((item, index) => <li key={item.id} className={step === item.id ? 'is-current' : ''} aria-current={step === item.id ? 'step' : undefined}><span>{index + 1}</span><strong>{item.label}</strong></li>)}
      </ol>
      {catalogLoading ? <div className="character-generator-catalog-status" role="status">{t('pluginGenerator.catalogLoading', '正在读取插件规则…')}</div> : catalogError === undefined ? null : <div className="character-generator-catalog-status is-error" role="alert"><Info size={16} aria-hidden="true" /><span>{catalogError}</span><button className="text-button" type="button" onClick={() => setCatalogRetry((value) => value + 1)}>{t('characterGenerator.retryCatalog', '重试读取目录')}</button></div>}
      <main className="character-generator__body">
        {step === 'source' ? <SourceStep sourceMode={source.kind} source={source.text} {...(source.fileName === undefined ? {} : { sourceFileName: source.fileName })} {...(sourceError === undefined ? {} : { error: sourceError })} analyzing={analyzing} copy={sourceCopy} onSourceMode={(kind) => setSource((current) => kind === 'file' ? { kind, text: current.text, ...(current.fileName === undefined ? {} : { fileName: current.fileName }) } : { kind, text: current.text })} onSource={handleSource} onFile={(file) => void handleSourceFile(file)} onAnalyze={analyze} /> : step === 'analysis' ? <PluginAnalysisStep source={source.text} {...(draft === undefined ? {} : { draft })} analyzing={analyzing} {...(analysisError === undefined ? {} : { error: analysisError })} onCancel={cancelAnalysis} onRetry={analyze} onContinue={() => { if (draft !== undefined) { setStep('preview'); setValidationError(undefined) } }} /> : step === 'preview' && draft !== undefined ? <PluginPreviewStep draft={draft} catalog={catalog} {...(validationError === undefined ? {} : { validationError })} onDraftChange={updateDraft} onTransformChange={updateTransform} onAddTransform={addTransform} onRemoveTransform={removeTransform} onBack={() => { setStep('analysis'); setValidationError(undefined) }} onContinue={continueToPublish} /> : <PluginPublishStep draft={draft ?? initialPluginDraft()} source={source.text} publishing={publishing} {...(publishError === undefined ? {} : { error: publishError })} published={publishedResult !== undefined} onBack={() => { setStep('preview'); setPublishError(undefined) }} onPublish={publish} onViewInstall={viewInstall} />}
      </main>
      {discardPrompt ? (
        <div ref={discardRef} className="character-generator-discard" role="alertdialog" aria-modal="true" aria-labelledby="plugin-generator-discard-title" aria-describedby="plugin-generator-discard-description">
          <strong id="plugin-generator-discard-title">{t('pluginGenerator.discardTitle', '放弃未保存的插件草稿？')}</strong>
          <span id="plugin-generator-discard-description">{t('characterGenerator.discardDescription', '返回市场会丢弃当前来源和编辑内容。')}</span>
          <div>
            <button className="secondary-button" type="button" onClick={keepEditing}>{t('characterGenerator.keepEditing', '继续编辑')}</button>
            <button className="danger-button" type="button" onClick={discard}>{t('characterGenerator.discard', '放弃草稿')}</button>
          </div>
        </div>
      ) : null}
      {step !== 'source' && publishedResult === undefined ? <button className="character-generator__back-link" type="button" onClick={requestClose}><ArrowLeft size={15} aria-hidden="true" />{t('pluginGenerator.back', '返回插件市场')}</button> : null}
    </div>
  )
}

function sourceErrorMessage(key: string, t: ReturnType<typeof useI18n>['t']): string {
  if (key === 'source.tooLarge') return t('characterGenerator.sourceTooLarge', '描述不能超过 128 KiB。')
  if (key === 'source.fileInvalid') return t('characterGenerator.sourceFileInvalid', '仅支持 Markdown 或纯文本文件。')
  return t('pluginGenerator.sourceEmpty', '请先输入提示词配方。')
}

function draftErrorMessage(key: string, draft: PluginDraft, catalog: PluginGeneratorCatalog, t: ReturnType<typeof useI18n>['t']): string {
  if (key === 'transform.triggerReserved') {
    const reserved = draft.transforms.find((transform, index) => transformIssue(transform, index, draft, catalog) === 'transform.triggerReserved')
    const owner = reserved === undefined ? undefined : reservedTriggerOwner(reserved.trigger, catalog)
    return t('pluginGenerator.triggerReserved', '触发词 {trigger} 已被官方插件「{owner}」使用，请换一个。', { trigger: reserved === undefined ? '' : normalizeTrigger(reserved.trigger), owner: owner?.displayName ?? '' })
  }
  const messages: Record<string, [string, string]> = {
    'draft.displayNameRequired': ['pluginGenerator.requiredName', '请输入插件名称。'],
    'draft.summaryRequired': ['pluginGenerator.requiredSummary', '请输入插件简介。'],
    'draft.transformsEmpty': ['pluginGenerator.transformsEmpty', '至少需要一条指令。'],
    'draft.transformsTooMany': ['pluginGenerator.transformsTooMany', '指令数量超过上限。'],
    'transform.triggerInvalid': ['pluginGenerator.triggerInvalid', '触发词必须以 / 开头，只包含小写字母、数字和连字符。'],
    'transform.triggerDuplicate': ['pluginGenerator.triggerDuplicate', '触发词不能重复。'],
    'transform.descriptionRequired': ['pluginGenerator.descriptionRequired', '请填写用途说明。'],
    'transform.descriptionTooLong': ['pluginGenerator.descriptionTooLong', '用途说明超过允许长度。'],
    'transform.instructionRequired': ['pluginGenerator.instructionRequired', '请填写指令内容。'],
    'transform.instructionTooLong': ['pluginGenerator.instructionTooLong', '指令内容超过允许长度。'],
    'transform.priorityInvalid': ['pluginGenerator.priorityInvalid', '优先级必须是整数。'],
  }
  const [messageKey, fallback] = messages[key] ?? ['characterGenerator.fieldTooLong', '内容超过允许长度。']
  return t(messageKey, fallback)
}

function isAbortError(cause: unknown): boolean {
  return (cause instanceof DOMException && cause.name === 'AbortError') || (cause instanceof Error && cause.name === 'AbortError')
}
