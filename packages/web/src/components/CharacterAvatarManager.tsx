import { ClockCounterClockwise, Cube, ImageSquare, UploadSimple, WarningCircle } from '@phosphor-icons/react'
import { lazy, Suspense, useMemo, useRef, useState } from 'react'
import type { CharacterAvatarAsset, EmployeeProfile, LocalAsset } from '@dsh-cyber/contracts'

import { formatDateTime } from '../i18n/format.js'
import { characterAvatarUrl, readCharacterAvatarProfile } from '../features/world/character-avatar-profile.js'
import { Avatar } from './Avatar.js'
import './character-avatar-manager.css'

const VrmAvatarPreview = lazy(async () => ({ default: (await import('../features/world/VrmAvatarPreview.js')).VrmAvatarPreview }))

export interface UploadedAvatarDraft {
  asset: LocalAsset
  avatarAsset: CharacterAvatarAsset
  url: string
}

interface CharacterAvatarManagerProps {
  employeeName: string
  profile?: EmployeeProfile | undefined
  profileHistory: EmployeeProfile[]
  fallbackAvatarIndex: number
  busy: boolean
  onFallbackAvatarChange(index: number): void
  onUpload(file: File): Promise<UploadedAvatarDraft>
  onPublish(assetId: string, fallbackAvatarIndex: number, expectedProfileRevision: number): Promise<void>
  onRollback(targetRevision: number, expectedProfileRevision: number): Promise<void>
  onReset(fallbackAvatarIndex: number, expectedProfileRevision: number): Promise<void>
}

export function CharacterAvatarManager({ employeeName, profile, profileHistory, fallbackAvatarIndex, busy, onFallbackAvatarChange, onUpload, onPublish, onRollback, onReset }: CharacterAvatarManagerProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<UploadedAvatarDraft>()
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string>()
  const currentAvatar = readCharacterAvatarProfile(profile?.appearance.digitalHumanAvatar)
  const previewKind = draft?.avatarAsset.rendererKind ?? currentAvatar?.rendererKind
  const previewUrl = draft?.url ?? characterAvatarUrl(currentAvatar)
  const historicalProfiles = useMemo(() => profileHistory
    .filter((item) => item.revision < (profile?.revision ?? 0))
    .slice(0, 6), [profile?.revision, profileHistory])

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

  return <section className="character-avatar-manager" aria-labelledby="character-avatar-manager-title">
    <header>
      <div><h4 id="character-avatar-manager-title">数字人形象</h4><p>导入图片或自包含 VRM。上传只生成本地预览，点击发布后才写入角色版本。</p></div>
      <button type="button" disabled={uploading || busy} onClick={() => fileRef.current?.click()}><UploadSimple size={16} aria-hidden="true" />{uploading ? '正在校验…' : '导入形象'}</button>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,.vrm,.glb,model/gltf-binary" hidden onChange={(event) => void upload(event.target.files?.[0])} />
    </header>

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
      {draft === undefined ? null : <div className="character-avatar-manager__draft" role="status"><strong>尚未发布</strong><span>{validationSummary(draft.avatarAsset)}</span><button type="button" className="primary-button" disabled={busy || draft.avatarAsset.rendererKind === 'mesh-preview'} onClick={() => void onPublish(draft.avatarAsset.assetId, fallbackAvatarIndex, profile?.revision ?? 0).then(() => setDraft(undefined))}>{draft.avatarAsset.rendererKind === 'mesh-preview' ? '需要 VRM 1.0' : '发布到角色'}</button><button type="button" disabled={busy} onClick={() => setDraft(undefined)}>放弃预览</button></div>}
      {error === undefined ? null : <div className="character-avatar-manager__error" role="alert"><WarningCircle size={16} aria-hidden="true" />{error}</div>}
    </div>

    <div className="character-avatar-manager__fallback">
      <div><strong>备用形象</strong><small>图片或 VRM 无法渲染、低性能降级和会话小头像使用这里的内置形象。</small></div>
      <div className="avatar-picker" role="radiogroup" aria-label="选择备用角色形象">{Array.from({ length: 8 }, (_, index) => <button key={index} type="button" role="radio" aria-label={`备用形象 ${index + 1}`} aria-checked={fallbackAvatarIndex === index} className={fallbackAvatarIndex === index ? 'is-active' : ''} onClick={() => onFallbackAvatarChange(index)}><Avatar index={index} size="md" label={`备用形象 ${index + 1}`} /></button>)}</div>
      {currentAvatar === undefined ? null : <button type="button" className="text-button" disabled={busy} onClick={() => void onReset(fallbackAvatarIndex, profile?.revision ?? 0)}>恢复为内置形象</button>}
    </div>

    {historicalProfiles.length === 0 ? null : <div className="character-avatar-manager__history">
      <div><ClockCounterClockwise size={17} aria-hidden="true" /><span><strong>形象版本</strong><small>恢复会创建新版本，不会改写历史。</small></span></div>
      <ol>{historicalProfiles.map((item) => {
        const avatar = readCharacterAvatarProfile(item.appearance.digitalHumanAvatar)
        return <li key={item.revision}><span><strong>版本 {item.revision} · {avatar?.sourceName ?? '内置形象'}</strong><small>{formatDateTime(item.createdAt)}</small></span><button type="button" disabled={busy} onClick={() => void onRollback(item.revision, profile?.revision ?? 0)}>恢复</button></li>
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
