import { ArrowLeft, Info } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CharacterBlueprintDraft, CharacterGeneratorAvatarCatalogItem, CharacterGeneratorAvatarSelection, CharacterGeneratorCatalog, CharacterSourceInput } from '@dsh-cyber/contracts'
import { useI18n } from '../../i18n/runtime.js'
import { analyzeCharacterSource, loadCharacterGeneratorCatalog, publishCharacterDraft, readUploadedAvatar } from './api.js'
import { AnalysisStep, PreviewStep, PublishStep, SourceStep } from './CharacterGeneratorSteps.js'
import {
  EMPTY_CHARACTER_CATALOG,
  CHARACTER_SOURCE_MAX_BYTES,
  initialCharacterDraft,
  trimDraft,
  validateCharacterDraft,
  validateCharacterSource,
  type CharacterGeneratorProps,
  type CharacterGeneratorStep,
} from './model.js'
import './CharacterGenerator.css'

export function CharacterGenerator({ workspaceId, targetWorld, onClose, onPublished, closeRequest = 0 }: CharacterGeneratorProps) {
  const { t } = useI18n()
  const viewRef = useRef<HTMLDivElement>(null)
  const discardRef = useRef<HTMLDivElement>(null)
  const discardReturnFocusRef = useRef<HTMLElement | undefined>(undefined)
  const activeRequestRef = useRef<AbortController | undefined>(undefined)
  const lastCloseRequestRef = useRef(closeRequest)
  const [step, setStep] = useState<CharacterGeneratorStep>('source')
  const [source, setSource] = useState<CharacterSourceInput>({ kind: 'description', text: '' })
  const [sourceError, setSourceError] = useState<string>()
  const [catalog, setCatalog] = useState<CharacterGeneratorCatalog>(() => EMPTY_CHARACTER_CATALOG)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState<string>()
  const [catalogRetry, setCatalogRetry] = useState(0)
  const [draft, setDraft] = useState<CharacterBlueprintDraft>()
  const [avatar, setAvatar] = useState<CharacterGeneratorAvatarSelection>()
  const [avatarError, setAvatarError] = useState<string>()
  const [analysisError, setAnalysisError] = useState<string>()
  const [analyzing, setAnalyzing] = useState(false)
  const [validationError, setValidationError] = useState<string>()
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string>()
  const [publishedResult, setPublishedResult] = useState<Parameters<CharacterGeneratorProps['onPublished']>[0]>()
  const [discardPrompt, setDiscardPrompt] = useState(false)
  const dirty = publishedResult === undefined && (source.text.trim().length > 0 || draft !== undefined || avatar?.kind === 'upload')

  useEffect(() => {
    if (avatar !== undefined || catalog.avatars[0] === undefined) return
    setAvatar({ kind: 'builtin', id: catalog.avatars[0].id })
  }, [avatar, catalog.avatars])

  useEffect(() => {
    const controller = new AbortController()
    setCatalogLoading(true)
    setCatalogError(undefined)
    void loadCharacterGeneratorCatalog(workspaceId, targetWorld.templateId, controller.signal)
      .then((nextCatalog) => setCatalog(nextCatalog))
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return
        setCatalogError(cause instanceof Error ? cause.message : t('characterGenerator.catalogError', '目录读取失败。仍可编辑基础角色资料，技能和能力会在目录恢复后显示。'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false)
      })
    return () => controller.abort()
  }, [catalogRetry, targetWorld.templateId, t, workspaceId])

  useEffect(() => {
    const first = viewRef.current?.querySelector<HTMLElement>('[data-generator-initial-focus]')
    first?.focus()
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

  // The confirmation is a modal alert dialog in its own right: focus starts on
  // the non-destructive option, Tab cannot wander back into the form behind
  // it, and Escape means "keep editing" rather than "discard again".
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
    setSource((current) => current.kind === 'file' && current.fileName !== undefined
      ? { kind: 'file', text: value, fileName: current.fileName }
      : { kind: current.kind, text: value })
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
      const text = await file.text()
      setSource({ kind: 'file', text, fileName: file.name })
      setSourceError(undefined)
      setAnalysisError(undefined)
      setPublishError(undefined)
    } catch {
      setSourceError(t('characterGenerator.sourceFileInvalid', '仅支持 Markdown 或纯文本文件。'))
    }
  }

  const analyze = () => {
    const sourceErrorKey = validateCharacterSource(source)
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
    void analyzeCharacterSource(workspaceId, source, targetWorld.templateId, controller.signal)
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

  const updateDraft = (patch: Partial<CharacterBlueprintDraft>) => {
    setDraft((current) => current === undefined ? current : { ...current, ...patch })
    setValidationError(undefined)
    setPublishError(undefined)
  }

  const selectAvatar = (option: CharacterGeneratorAvatarCatalogItem) => {
    setAvatar({ kind: 'builtin', id: option.id })
    setAvatarError(undefined)
  }

  const uploadAvatar = (file: File) => {
    setAvatarError(undefined)
    void readUploadedAvatar(file)
      .then((selection) => setAvatar(selection))
      .catch((cause: unknown) => setAvatarError(cause instanceof Error ? cause.message : t('characterGenerator.avatarUploadError', '头像上传失败。请换一张 PNG、JPEG 或 WebP 图片。')))
  }

  const continueToPublish = () => {
    if (draft === undefined) return
    const nextDraft = trimDraft(draft)
    const errorKey = validateCharacterDraft(nextDraft, catalog)
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
    const nextDraft = trimDraft(draft)
    const errorKey = validateCharacterDraft(nextDraft, catalog)
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
    void publishCharacterDraft(workspaceId, source, nextDraft, avatar, controller.signal)
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

  const stepLabels: Array<{ id: CharacterGeneratorStep; label: string }> = [
    { id: 'source', label: t('characterGenerator.stepSource', '创建方式') },
    { id: 'analysis', label: t('characterGenerator.stepAnalysis', 'AI 分析') },
    { id: 'preview', label: t('characterGenerator.stepPreview', '预览编辑') },
    { id: 'publish', label: t('characterGenerator.stepPublish', '发布角色') },
  ]

  return (
    <div ref={viewRef} className="character-generator">
      <ol className="character-generator__steps" aria-label={t('characterGenerator.stepSource', '创建方式')}>
        {stepLabels.map((item, index) => <li key={item.id} className={step === item.id ? 'is-current' : ''} aria-current={step === item.id ? 'step' : undefined}><span>{index + 1}</span><strong>{item.label}</strong></li>)}
      </ol>
      {catalogLoading ? <div className="character-generator-catalog-status" role="status">{t('characterGenerator.catalogLoading', '正在读取当前世界可用目录…')}</div> : catalogError === undefined ? null : <div className="character-generator-catalog-status is-error" role="alert"><Info size={16} aria-hidden="true" /><span>{catalogError}</span><button className="text-button" type="button" onClick={() => setCatalogRetry((value) => value + 1)}>{t('characterGenerator.retryCatalog', '重试读取目录')}</button></div>}
      <main className="character-generator__body">
        {step === 'source' ? <SourceStep sourceMode={source.kind} source={source.text} {...(source.fileName === undefined ? {} : { sourceFileName: source.fileName })} {...(sourceError === undefined ? {} : { error: sourceError })} analyzing={analyzing} onSourceMode={(kind) => setSource((current) => kind === 'file' ? { kind, text: current.text, ...(current.fileName === undefined ? {} : { fileName: current.fileName }) } : { kind, text: current.text })} onSource={handleSource} onFile={(file) => void handleSourceFile(file)} onAnalyze={analyze} /> : step === 'analysis' ? <AnalysisStep source={source.text} {...(draft === undefined ? {} : { draft })} analyzing={analyzing} {...(analysisError === undefined ? {} : { error: analysisError })} onCancel={cancelAnalysis} onRetry={analyze} onContinue={() => { if (draft !== undefined) { setStep('preview'); setValidationError(undefined) } }} /> : step === 'preview' && draft !== undefined ? <PreviewStep draft={draft} catalog={catalog} {...(avatar === undefined ? {} : { avatar })} {...(avatarError === undefined ? {} : { avatarError })} {...(validationError === undefined ? {} : { validationError })} onDraftChange={updateDraft} onAvatarSelect={selectAvatar} onAvatarUpload={uploadAvatar} onBack={() => { setStep('analysis'); setValidationError(undefined) }} onContinue={continueToPublish} /> : <PublishStep draft={draft ?? initialCharacterDraft(targetWorld.templateId)} source={source.text} {...(avatar === undefined ? {} : { avatar })} catalog={catalog} publishing={publishing} {...(publishError === undefined ? {} : { error: publishError })} published={publishedResult !== undefined} onBack={() => { setStep('preview'); setPublishError(undefined) }} onPublish={publish} onViewInstall={viewInstall} />}
      </main>
      {discardPrompt ? (
        <div
          ref={discardRef}
          className="character-generator-discard"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="character-generator-discard-title"
          aria-describedby="character-generator-discard-description"
        >
          <strong id="character-generator-discard-title">{t('characterGenerator.discardTitle', '放弃未保存的角色草稿？')}</strong>
          <span id="character-generator-discard-description">{t('characterGenerator.discardDescription', '返回市场会丢弃当前来源和编辑内容。')}</span>
          <div>
            <button className="secondary-button" type="button" onClick={keepEditing}>{t('characterGenerator.keepEditing', '继续编辑')}</button>
            <button className="danger-button" type="button" onClick={discard}>{t('characterGenerator.discard', '放弃草稿')}</button>
          </div>
        </div>
      ) : null}
      {step !== 'source' && publishedResult === undefined ? <button className="character-generator__back-link" type="button" onClick={requestClose}><ArrowLeft size={15} aria-hidden="true" />{t('characterGenerator.back', '返回角色市场')}</button> : null}
    </div>
  )
}

function sourceErrorMessage(key: string, t: ReturnType<typeof useI18n>['t']): string {
  if (key === 'source.tooLarge') return t('characterGenerator.sourceTooLarge', '描述不能超过 128 KiB。')
  if (key === 'source.fileInvalid') return t('characterGenerator.sourceFileInvalid', '仅支持 Markdown 或纯文本文件。')
  return t('characterGenerator.sourceEmpty', '请先输入角色描述。')
}

function draftErrorMessage(key: string, t: ReturnType<typeof useI18n>['t']): string {
  const messages: Record<string, [string, string]> = {
    'draft.displayNameRequired': ['characterGenerator.requiredName', '请输入角色名字。'],
    'draft.displayNameTooLong': ['characterGenerator.fieldTooLong', '内容超过允许长度。'],
    'draft.roleRequired': ['characterGenerator.requiredRole', '请输入岗位或身份。'],
    'draft.roleTooLong': ['characterGenerator.fieldTooLong', '内容超过允许长度。'],
    'draft.summaryRequired': ['characterGenerator.requiredSummary', '请输入角色简介。'],
    'draft.summaryTooLong': ['characterGenerator.fieldTooLong', '内容超过允许长度。'],
    'draft.personaRequired': ['characterGenerator.requiredPersona', '请输入 Persona 与行为方式。'],
    'draft.personaTooLong': ['characterGenerator.fieldTooLong', '内容超过允许长度。'],
    'draft.backgroundTooLong': ['characterGenerator.fieldTooLong', '内容超过允许长度。'],
    'draft.traitsTooLong': ['characterGenerator.fieldTooLong', '内容超过允许长度。'],
    'draft.skillUnavailable': ['characterGenerator.unavailableSkill', '草稿包含当前目录中不可用的技能。'],
    'draft.capabilityUnavailable': ['characterGenerator.unavailableCapability', '草稿包含当前目录中不可用的能力。'],
  }
  const [messageKey, fallback] = messages[key] ?? ['characterGenerator.fieldTooLong', '内容超过允许长度。']
  return t(messageKey, fallback)
}

function isAbortError(cause: unknown): boolean {
  return (cause instanceof DOMException && cause.name === 'AbortError') || (cause instanceof Error && cause.name === 'AbortError')
}
