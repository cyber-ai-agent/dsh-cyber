import { ArrowLeft, Info } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CharacterSourceInput, CyberSkinPaletteV1, SkinDraft, SkinGeneratorBackdropSelection, SkinGeneratorCatalog } from '@dsh-cyber/contracts'
import { useI18n } from '../../i18n/runtime.js'
import { SourceStep } from '../character-generator/CharacterGeneratorSteps.js'
import { CHARACTER_SOURCE_MAX_BYTES } from '../character-generator/model.js'
import { analyzeSkinSource, loadSkinGeneratorCatalog, publishSkinDraft } from './api.js'
import { SkinAnalysisStep, SkinPreviewStep, SkinPublishStep } from './SkinGeneratorSteps.js'
import {
  EMPTY_SKIN_CATALOG,
  defaultBackdropSelection,
  initialSkinDraft,
  trimSkinDraft,
  validateSkinDraft,
  validateSkinSource,
  type SkinGeneratorProps,
  type SkinGeneratorStep,
} from './model.js'
import '../character-generator/CharacterGenerator.css'
import './SkinGenerator.css'

/**
 * 皮肤 → 自定义皮肤. The third generator, built on the Character Generator's
 * product pattern: 来源 → AI 分析 → 预览编辑 → 显式发布. Publish produces a
 * declaration-only skin package in the workspace's own generated marketplace;
 * nothing is installed or applied here.
 */
export function SkinGenerator({ workspaceId, onClose, onPublished, closeRequest = 0 }: SkinGeneratorProps) {
  const { t } = useI18n()
  const viewRef = useRef<HTMLDivElement>(null)
  const discardRef = useRef<HTMLDivElement>(null)
  const discardReturnFocusRef = useRef<HTMLElement | undefined>(undefined)
  const activeRequestRef = useRef<AbortController | undefined>(undefined)
  const lastCloseRequestRef = useRef(closeRequest)
  const [step, setStep] = useState<SkinGeneratorStep>('source')
  const [source, setSource] = useState<CharacterSourceInput>({ kind: 'description', text: '' })
  const [sourceError, setSourceError] = useState<string>()
  const [catalog, setCatalog] = useState<SkinGeneratorCatalog>(() => EMPTY_SKIN_CATALOG)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState<string>()
  const [catalogRetry, setCatalogRetry] = useState(0)
  const [draft, setDraft] = useState<SkinDraft>()
  const [backdrop, setBackdrop] = useState<SkinGeneratorBackdropSelection>()
  const [analysisError, setAnalysisError] = useState<string>()
  const [analyzing, setAnalyzing] = useState(false)
  const [validationError, setValidationError] = useState<string>()
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string>()
  const [publishedResult, setPublishedResult] = useState<Parameters<SkinGeneratorProps['onPublished']>[0]>()
  const [discardPrompt, setDiscardPrompt] = useState(false)
  const dirty = publishedResult === undefined && (source.text.trim().length > 0 || draft !== undefined)

  useEffect(() => {
    // A backdrop the catalog no longer lists falls back to colours-only.
    if (backdrop !== undefined && !catalog.backdrops.some((option) => option.id === backdrop.id)) setBackdrop(undefined)
  }, [backdrop, catalog])

  useEffect(() => {
    const controller = new AbortController()
    setCatalogLoading(true)
    setCatalogError(undefined)
    void loadSkinGeneratorCatalog(workspaceId, controller.signal)
      .then((nextCatalog) => setCatalog(nextCatalog))
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return
        setCatalogError(cause instanceof Error ? cause.message : t('skinGenerator.catalogError', '目录读取失败。仍可编辑配色，官方背景会在目录恢复后显示。'))
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
    const sourceErrorKey = validateSkinSource(source)
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
    void analyzeSkinSource(workspaceId, source, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setDraft(result.draft)
        setBackdrop(defaultBackdropSelection(catalog, result.suggestedBackdropId))
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

  const updateDraft = (patch: Partial<SkinDraft>) => {
    setDraft((current) => current === undefined ? current : { ...current, ...patch })
    setValidationError(undefined)
    setPublishError(undefined)
  }

  const updatePalette = (patch: Partial<CyberSkinPaletteV1>) => {
    setDraft((current) => current === undefined ? current : { ...current, palette: { ...current.palette, ...patch } })
    setValidationError(undefined)
    setPublishError(undefined)
  }

  const continueToPublish = () => {
    if (draft === undefined) return
    const nextDraft = trimSkinDraft(draft)
    const errorKey = validateSkinDraft(nextDraft)
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
    const nextDraft = trimSkinDraft(draft)
    const errorKey = validateSkinDraft(nextDraft)
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
    void publishSkinDraft(workspaceId, source, nextDraft, backdrop, controller.signal)
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

  const stepLabels: Array<{ id: SkinGeneratorStep; label: string }> = [
    { id: 'source', label: t('characterGenerator.stepSource', '创建方式') },
    { id: 'analysis', label: t('characterGenerator.stepAnalysis', 'AI 分析') },
    { id: 'preview', label: t('characterGenerator.stepPreview', '预览编辑') },
    { id: 'publish', label: t('skinGenerator.stepPublish', '发布皮肤') },
  ]
  const selectedBackdrop = backdrop === undefined ? undefined : catalog.backdrops.find((option) => option.id === backdrop.id)
  const sourceCopy = {
    intro: t('skinGenerator.sourceIntro', '从一段风格描述开始'),
    hint: t('skinGenerator.sourceHint', '描述你想要的氛围：整体色调、面板质感、气泡的冷暖、文字的明暗。支持 Markdown 或纯文本。'),
    label: t('skinGenerator.sourceLabel', '皮肤描述'),
    placeholder: t('skinGenerator.sourcePlaceholder', '例如：一间安静的深夜图书馆，深蓝底色、暖黄阅读灯、木质书架的沉稳感。'),
    safety: t('skinGenerator.sourceSafety', '来源内容是不可信数据。分析结果需要你逐项检查后才会生成皮肤包。'),
  }

  return (
    <div ref={viewRef} className="character-generator skin-generator">
      <ol className="character-generator__steps" aria-label={t('characterGenerator.stepSource', '创建方式')}>
        {stepLabels.map((item, index) => <li key={item.id} className={step === item.id ? 'is-current' : ''} aria-current={step === item.id ? 'step' : undefined}><span>{index + 1}</span><strong>{item.label}</strong></li>)}
      </ol>
      {catalogLoading ? <div className="character-generator-catalog-status" role="status">{t('skinGenerator.catalogLoading', '正在读取官方背景目录…')}</div> : catalogError === undefined ? null : <div className="character-generator-catalog-status is-error" role="alert"><Info size={16} aria-hidden="true" /><span>{catalogError}</span><button className="text-button" type="button" onClick={() => setCatalogRetry((value) => value + 1)}>{t('characterGenerator.retryCatalog', '重试读取目录')}</button></div>}
      <main className="character-generator__body">
        {step === 'source' ? <SourceStep sourceMode={source.kind} source={source.text} {...(source.fileName === undefined ? {} : { sourceFileName: source.fileName })} {...(sourceError === undefined ? {} : { error: sourceError })} analyzing={analyzing} copy={sourceCopy} onSourceMode={(kind) => setSource((current) => kind === 'file' ? { kind, text: current.text, ...(current.fileName === undefined ? {} : { fileName: current.fileName }) } : { kind, text: current.text })} onSource={handleSource} onFile={(file) => void handleSourceFile(file)} onAnalyze={analyze} /> : step === 'analysis' ? <SkinAnalysisStep source={source.text} {...(draft === undefined ? {} : { draft })} analyzing={analyzing} {...(analysisError === undefined ? {} : { error: analysisError })} onCancel={cancelAnalysis} onRetry={analyze} onContinue={() => { if (draft !== undefined) { setStep('preview'); setValidationError(undefined) } }} /> : step === 'preview' && draft !== undefined ? <SkinPreviewStep draft={draft} catalog={catalog} {...(backdrop === undefined ? {} : { backdrop })} {...(validationError === undefined ? {} : { validationError })} onDraftChange={updateDraft} onPaletteChange={updatePalette} onBackdropSelect={setBackdrop} onBack={() => { setStep('analysis'); setValidationError(undefined) }} onContinue={continueToPublish} /> : <SkinPublishStep draft={draft ?? initialSkinDraft()} source={source.text} {...(selectedBackdrop === undefined ? {} : { backdrop: selectedBackdrop })} publishing={publishing} {...(publishError === undefined ? {} : { error: publishError })} published={publishedResult !== undefined} onBack={() => { setStep('preview'); setPublishError(undefined) }} onPublish={publish} onViewInstall={viewInstall} />}
      </main>
      {discardPrompt ? (
        <div ref={discardRef} className="character-generator-discard" role="alertdialog" aria-modal="true" aria-labelledby="skin-generator-discard-title" aria-describedby="skin-generator-discard-description">
          <strong id="skin-generator-discard-title">{t('skinGenerator.discardTitle', '放弃未保存的皮肤草稿？')}</strong>
          <span id="skin-generator-discard-description">{t('characterGenerator.discardDescription', '返回市场会丢弃当前来源和编辑内容。')}</span>
          <div>
            <button className="secondary-button" type="button" onClick={keepEditing}>{t('characterGenerator.keepEditing', '继续编辑')}</button>
            <button className="danger-button" type="button" onClick={discard}>{t('characterGenerator.discard', '放弃草稿')}</button>
          </div>
        </div>
      ) : null}
      {step !== 'source' && publishedResult === undefined ? <button className="character-generator__back-link" type="button" onClick={requestClose}><ArrowLeft size={15} aria-hidden="true" />{t('skinGenerator.back', '返回皮肤市场')}</button> : null}
    </div>
  )
}

function sourceErrorMessage(key: string, t: ReturnType<typeof useI18n>['t']): string {
  if (key === 'source.tooLarge') return t('characterGenerator.sourceTooLarge', '描述不能超过 128 KiB。')
  if (key === 'source.fileInvalid') return t('characterGenerator.sourceFileInvalid', '仅支持 Markdown 或纯文本文件。')
  return t('skinGenerator.sourceEmpty', '请先输入皮肤描述。')
}

function draftErrorMessage(key: string, t: ReturnType<typeof useI18n>['t']): string {
  const messages: Record<string, [string, string]> = {
    'draft.displayNameRequired': ['skinGenerator.requiredName', '请输入皮肤名称。'],
    'draft.summaryRequired': ['skinGenerator.requiredSummary', '请输入皮肤简介。'],
    'draft.colorInvalid': ['skinGenerator.colorInvalid', '所有颜色都必须是 #rrggbb 形式。'],
    'draft.opacityInvalid': ['skinGenerator.opacityInvalid', '背景透明度必须在 0.2 到 1 之间。'],
  }
  const [messageKey, fallback] = messages[key] ?? ['characterGenerator.fieldTooLong', '内容超过允许长度。']
  return t(messageKey, fallback)
}

function isAbortError(cause: unknown): boolean {
  return (cause instanceof DOMException && cause.name === 'AbortError') || (cause instanceof Error && cause.name === 'AbortError')
}
