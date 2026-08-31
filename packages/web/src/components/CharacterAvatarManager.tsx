import { ClockCounterClockwise, Cube, ImageSquare, Sparkle, UploadSimple, WarningCircle } from '@phosphor-icons/react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { CharacterAvatarAsset, CharacterGender, EmployeeProfile, LocalAsset } from '@dsh-cyber/contracts'

import { formatDateTime } from '../i18n/format.js'
import { characterAvatarUrl, readCharacterAvatarProfile } from '../features/world/character-avatar-profile.js'
import type { AvatarCreationPhase } from '../features/world/avatar/avatar-creation-provider.js'
import { avatarRecipeForCharacter } from '../features/world/avatar/avatar-recipe.js'
import type { ProceduralAvatarBuild, ProceduralAvatarStyle, ProceduralAvatarTone } from '../features/world/avatar/procedural-vrm.js'
import { Avatar } from './Avatar.js'
import './character-avatar-manager.css'

const VrmAvatarPreview = lazy(async () => ({ default: (await import('../features/world/VrmAvatarPreview.js')).VrmAvatarPreview }))

const STYLE_OPTIONS: Array<{ value: ProceduralAvatarStyle; label: string; description: string }> = [
  { value: 'professional', label: '职业', description: '保留角色主色，换成清晰职业轮廓' },
  { value: 'casual', label: '日常', description: '保留角色主色，使用更轻松的服装结构' },
  { value: 'future', label: '未来', description: '保留角色主色，增加轻量科技细节' },
]
const BUILD_OPTIONS: Array<{ value: ProceduralAvatarBuild; label: string }> = [
  { value: 'slender', label: '轻盈' },
  { value: 'balanced', label: '标准' },
  { value: 'sturdy', label: '强健' },
]
const TONE_OPTIONS: Array<{ value: ProceduralAvatarTone; label: string }> = [
  { value: 'warm', label: '浅暖' },
  { value: 'neutral', label: '自然' },
  { value: 'deep', label: '深色' },
]

export interface UploadedAvatarDraft {
  asset: LocalAsset
  avatarAsset: CharacterAvatarAsset
  url: string
}

interface CharacterAvatarManagerProps {
  employeeName: string
  /** Current identity fields; optional for compatibility with isolated tests/legacy callers. */
  employeeId?: string
  employeeRole?: string
  employeeGender?: CharacterGender
  profile?: EmployeeProfile | undefined
  profileHistory: EmployeeProfile[]
  fallbackAvatarIndex: number
  busy: boolean
  focusOnMount?: boolean
  onFallbackAvatarChange(index: number): void
  onUpload(file: File, signal?: AbortSignal): Promise<UploadedAvatarDraft>
  onPublish(assetId: string, fallbackAvatarIndex: number, expectedProfileRevision: number): Promise<void>
  onRollback(targetRevision: number, expectedProfileRevision: number): Promise<void>
  onReset(fallbackAvatarIndex: number, expectedProfileRevision: number): Promise<void>
}

export function CharacterAvatarManager({ employeeName, employeeId, employeeRole, employeeGender, profile, profileHistory, fallbackAvatarIndex, busy, focusOnMount = false, onFallbackAvatarChange, onUpload, onPublish, onRollback, onReset }: CharacterAvatarManagerProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const createButtonRef = useRef<HTMLButtonElement>(null)
  const publishButtonRef = useRef<HTMLButtonElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const creationAbortRef = useRef<AbortController | undefined>(undefined)
  const [draft, setDraft] = useState<UploadedAvatarDraft>()
  const [uploading, setUploading] = useState(false)
  const [creationPhase, setCreationPhase] = useState<AvatarCreationPhase>()
  const [creatorOpen, setCreatorOpen] = useState(false)
  const [style, setStyle] = useState<ProceduralAvatarStyle>('professional')
  const [build, setBuild] = useState<ProceduralAvatarBuild>('balanced')
  const [tone, setTone] = useState<ProceduralAvatarTone>('neutral')
  const [error, setError] = useState<string>()
  const currentAvatar = readCharacterAvatarProfile(profile?.appearance.digitalHumanAvatar)
  const previewKind = draft?.avatarAsset.rendererKind ?? currentAvatar?.rendererKind
  const previewUrl = draft?.url ?? characterAvatarUrl(currentAvatar)
  const creating = creationPhase !== undefined
  const historicalProfiles = useMemo(() => profileHistory
    .filter((item) => item.revision < (profile?.revision ?? 0))
    .slice(0, 6), [profile?.revision, profileHistory])
  const identityRecipe = useMemo(() => avatarRecipeForCharacter({
    employeeId: employeeId ?? profile?.employeeId ?? 'local-character',
    role: employeeRole,
    gender: employeeGender ?? profile?.gender,
    fallbackAvatarIndex,
    appearance: profile?.appearance,
  }), [employeeGender, employeeId, employeeRole, fallbackAvatarIndex, profile?.appearance, profile?.employeeId, profile?.gender])

  useEffect(() => {
    if (!focusOnMount) return
    const frame = requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ block: 'start' })
      createButtonRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [focusOnMount])
  useEffect(() => {
    if (draft === undefined) return
    const frame = requestAnimationFrame(() => publishButtonRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [draft?.asset.id])
  useEffect(() => {
    if (error === undefined) return
    const frame = requestAnimationFrame(() => errorRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [error])
  useEffect(() => () => {
    const controller = creationAbortRef.current
    creationAbortRef.current = undefined
    controller?.abort()
  }, [])

  const upload = async (file: File | undefined) => {
    if (file === undefined || uploading || busy) return
    setUploading(true)
    setError(undefined)
    try {
      setDraft(await onUpload(file))
    } catch (cause) {
      setDraft(undefined)
      setError(cause instanceof Error ? cause.message : '角色形象上传失败')
    } finally {
      setUploading(false)
      if (fileRef.current !== null) fileRef.current.value = ''
    }
  }

  const createAvatar = async () => {
    if (creating || uploading || busy) return
    const controller = new AbortController()
    creationAbortRef.current = controller
    setCreationPhase('generating')
    setError(undefined)
    try {
      const { avatarCreationProviders, LOCAL_PROCEDURAL_AVATAR_PROVIDER_ID } = await import('../features/world/avatar/avatar-creation-provider.js')
      const provider = avatarCreationProviders.require(LOCAL_PROCEDURAL_AVATAR_PROVIDER_ID)
      const created = await provider.create({
        displayName: employeeName,
        design: { style, build, tone },
        identityRecipe,
      }, { onPhase: setCreationPhase, signal: controller.signal })
      if (creationAbortRef.current !== controller) return
      setCreationPhase('validating')
      const uploaded = await onUpload(created.file, controller.signal)
      if (creationAbortRef.current !== controller) return
      setDraft(uploaded)
      setCreatorOpen(false)
    } catch (cause) {
      if (creationAbortRef.current !== controller) return
      if (cause instanceof DOMException && cause.name === 'AbortError') return
      setDraft(undefined)
      setError(cause instanceof Error ? cause.message : '3D 形象创建失败')
    } finally {
      if (creationAbortRef.current === controller) {
        creationAbortRef.current = undefined
        setCreationPhase(undefined)
      }
    }
  }

  const closeCreator = () => {
    const controller = creationAbortRef.current
    creationAbortRef.current = undefined
    controller?.abort()
    setCreatorOpen(false)
    setCreationPhase(undefined)
    requestAnimationFrame(() => createButtonRef.current?.focus())
  }

  const publishDraft = async (assetId: string) => {
    setError(undefined)
    try {
      await onPublish(assetId, fallbackAvatarIndex, profile?.revision ?? 0)
      setDraft(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色形象发布失败')
    }
  }

  const rollbackAvatar = async (targetRevision: number) => {
    setError(undefined)
    try {
      await onRollback(targetRevision, profile?.revision ?? 0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色形象恢复失败')
    }
  }

  const resetAvatar = async () => {
    setError(undefined)
    try {
      await onReset(fallbackAvatarIndex, profile?.revision ?? 0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '内置形象恢复失败')
    }
  }

  return <section ref={sectionRef} className="character-avatar-manager" aria-labelledby="character-avatar-manager-title">
    <header>
      <div><h4 id="character-avatar-manager-title">数字人形象</h4><p>本机 3D 会沿用当前角色的身份配方；生成后先预览，确认发布才会替换当前版本。</p></div>
      <button ref={createButtonRef} type="button" aria-expanded={creatorOpen} aria-controls="character-avatar-creator" disabled={creating || uploading || busy} onClick={() => setCreatorOpen((value) => !value)}><Sparkle size={16} aria-hidden="true" />{currentAvatar?.rendererKind === 'vrm-3d' ? '重新创建 3D' : '创建 3D 形象'}</button>
    </header>

    {creatorOpen ? <div id="character-avatar-creator" className="character-avatar-manager__creator" aria-labelledby="character-avatar-creator-title" aria-busy={creating}>
      <div className="character-avatar-manager__creator-heading"><span><Sparkle size={17} aria-hidden="true" /></span><div><strong id="character-avatar-creator-title">创建 {employeeName} 的 3D 形象</strong><small>沿用角色发型与主色 · 本机生成 · 不发送角色资料</small></div></div>
      <fieldset className="character-avatar-manager__style-options">
        <legend>外观风格</legend>
        <div>{STYLE_OPTIONS.map((option) => <label key={option.value} className={style === option.value ? 'is-selected' : ''}><input type="radio" name="procedural-avatar-style" value={option.value} checked={style === option.value} onChange={() => setStyle(option.value)} /><span className="character-avatar-manager__style-swatch" data-style={option.value} aria-hidden="true" /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}</div>
      </fieldset>
      <div className="character-avatar-manager__creator-grid">
        <fieldset><legend>体型</legend><div>{BUILD_OPTIONS.map((option) => <label key={option.value} className={build === option.value ? 'is-selected' : ''}><input type="radio" name="procedural-avatar-build" value={option.value} checked={build === option.value} onChange={() => setBuild(option.value)} /><span>{option.label}</span></label>)}</div></fieldset>
        <fieldset><legend>肤色</legend><div>{TONE_OPTIONS.map((option) => <label key={option.value} className={tone === option.value ? 'is-selected' : ''}><input type="radio" name="procedural-avatar-tone" value={option.value} checked={tone === option.value} onChange={() => setTone(option.value)} /><span className="character-avatar-manager__tone-swatch" data-tone={option.value} aria-hidden="true" /><span>{option.label}</span></label>)}</div></fieldset>
      </div>
      <div className="character-avatar-manager__creator-actions"><button type="button" className="primary-button" disabled={creating || uploading || busy} onClick={() => void createAvatar()}><Cube size={16} aria-hidden="true" />{creationPhase === 'validating' ? '正在校验预览…' : creating ? '正在本机生成…' : '生成 3D 预览'}</button><button type="button" onClick={closeCreator}>{creating ? '取消生成' : '取消'}</button><small>身份配方只描述外观，不会修改角色记忆、设定或能力。</small></div>
      {creationPhase === undefined ? null : <span className="character-avatar-manager__creation-status" role="status" aria-live="polite">{creationPhase === 'generating' ? '正在按角色身份配方生成低面数模型，不会阻塞聊天和世界操作。' : creationPhase === 'packaging' ? '模型已生成，正在整理为自包含 VRM。' : '正在校验骨骼、资源完整性和发布能力。'}</span>}
    </div> : null}

    <div className="character-avatar-manager__preview">
      <div className="character-avatar-manager__stage" data-kind={previewKind ?? 'builtin'}>
        {previewKind === undefined || previewUrl === undefined
          ? <Avatar index={fallbackAvatarIndex} size="lg" label={`${employeeName}内置形象`} />
          : previewKind === 'image-2d'
            ? <img src={previewUrl} alt={`${employeeName}形象预览`} />
            : <Suspense fallback={<span role="status">正在准备 3D 预览器…</span>}><VrmAvatarPreview assetUrl={previewUrl} label={`${employeeName} 3D 预览`} staticMode allowGenericGlb={previewKind === 'mesh-preview'} /></Suspense>}
      </div>
      <div className="character-avatar-manager__summary">
        <span>{previewKind === 'vrm-3d' || previewKind === 'mesh-preview' ? <Cube size={17} aria-hidden="true" /> : <ImageSquare size={17} aria-hidden="true" />}</span>
        <div><strong>{draft?.avatarAsset.originalName ?? currentAvatar?.sourceName ?? '内置形象'}</strong><small>{previewKind === 'vrm-3d' ? 'VRM 3D · 按需加载，失败自动回退' : previewKind === 'mesh-preview' ? '普通 GLB · 仅可预览，不能发布为数字人' : previewKind === 'image-2d' ? '本地图片 · 不上传到云端' : 'DSH Cyber 内置形象'}</small></div>
      </div>
      {draft === undefined ? null : <div className="character-avatar-manager__draft" role="status"><strong>尚未发布</strong><span>{validationSummary(draft.avatarAsset)}</span><button ref={publishButtonRef} type="button" className="primary-button" disabled={busy || draft.avatarAsset.rendererKind === 'mesh-preview'} onClick={() => void publishDraft(draft.avatarAsset.assetId)}>{draft.avatarAsset.rendererKind === 'mesh-preview' ? '需要 VRM 1.0' : '发布到角色'}</button><button type="button" disabled={busy} onClick={() => setDraft(undefined)}>放弃预览</button></div>}
      {error === undefined ? null : <div ref={errorRef} className="character-avatar-manager__error" role="alert" tabIndex={-1}><WarningCircle size={16} aria-hidden="true" />{error}</div>}
    </div>

    <details className="character-avatar-manager__import">
      <summary>高级方式：导入现有形象</summary>
      <div><p>已有图片、VRM 1.0 或 GLB 时可在这里导入。普通用户无需使用此入口。</p><button type="button" disabled={uploading || creating || busy} onClick={() => fileRef.current?.click()}><UploadSimple size={16} aria-hidden="true" />{uploading ? '正在校验…' : '选择本地文件'}</button></div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,.vrm,.glb,model/gltf-binary" hidden onChange={(event) => void upload(event.target.files?.[0])} />
    </details>

    <div className="character-avatar-manager__fallback">
      <div><strong>备用形象</strong><small>这个内置形象同时作为本机 3D 的身份种子；切换后，新生成的 3D 会同步发型与主色。</small></div>
      <div className="avatar-picker" role="radiogroup" aria-label="选择备用角色形象">{Array.from({ length: 8 }, (_, index) => <button key={index} type="button" role="radio" aria-label={`备用形象 ${index + 1}`} aria-checked={fallbackAvatarIndex === index} className={fallbackAvatarIndex === index ? 'is-active' : ''} onClick={() => onFallbackAvatarChange(index)}><Avatar index={index} size="md" label={`备用形象 ${index + 1}`} /></button>)}</div>
      {currentAvatar === undefined ? null : <button type="button" className="text-button" disabled={busy} onClick={() => void resetAvatar()}>恢复为内置形象</button>}
    </div>

    {historicalProfiles.length === 0 ? null : <div className="character-avatar-manager__history">
      <div><ClockCounterClockwise size={17} aria-hidden="true" /><span><strong>形象版本</strong><small>恢复会创建新版本，不会改写历史。</small></span></div>
      <ol>{historicalProfiles.map((item) => {
        const avatar = readCharacterAvatarProfile(item.appearance.digitalHumanAvatar)
        return <li key={item.revision}><span><strong>版本 {item.revision} · {avatar?.sourceName ?? '内置形象'}</strong><small>{formatDateTime(item.createdAt)}</small></span><button type="button" disabled={busy} onClick={() => void rollbackAvatar(item.revision)}>恢复</button></li>
      })}</ol>
    </div>}
  </section>
}

function validationSummary(asset: CharacterAvatarAsset): string {
  if (asset.rendererKind === 'image-2d') return '图片签名已校验，可发布为 2D 角色形象。'
  if (asset.rendererKind === 'mesh-preview') return 'GLB 结构有效，但缺少 VRMC_vrm 1.0 身份与 Humanoid，只允许预览。'
  const bones = typeof asset.validation.humanBoneCount === 'number' ? `${asset.validation.humanBoneCount} 个骨骼` : 'Humanoid 已识别'
  const expressions = typeof asset.validation.expressionCount === 'number' ? `${asset.validation.expressionCount} 个表情` : '表情信息已读取'
  return `自包含 VRM 1.0 · ${bones} · ${expressions}`
}
