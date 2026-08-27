import { Check, Copy, DownloadSimple, FileArrowUp, X } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import type { WorldTemplateManifest } from '@dsh-cyber/contracts'
import type { EmbodimentPresetDescriptor } from '@dsh-cyber/contracts/creative-platform'

import { analyzeWorkshopPrompt } from './prompt-parser.js'
import type { WorkshopDraft } from './model.js'

export function WorkshopJsonEditor({ draft, templates, presets, onApply, onClose }: {
  draft: WorkshopDraft
  templates: WorldTemplateManifest[]
  presets: EmbodimentPresetDescriptor[]
  onApply(draft: WorkshopDraft): void
  onClose(): void
}) {
  const [value, setValue] = useState(() => portableDraftJson(draft))
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => setValue(portableDraftJson(draft)), [draft])

  const apply = () => {
    try {
      const next = analyzeWorkshopPrompt(value, templates, presets, draft).draft
      onApply(next)
      setValue(portableDraftJson(next))
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'JSON 草稿格式不正确')
    }
  }

  const exportJson = () => {
    const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${draft.displayName.trim() || 'creative-workshop-draft'}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return <div className="workshop-json-backdrop" role="presentation">
    <section className="workshop-json-editor" role="dialog" aria-modal="true" aria-labelledby="workshop-json-title">
      <header><div><h3 id="workshop-json-title">查看和编辑 JSON 草稿</h3><p>JSON 与可视化表单共享同一份草稿；应用前会重新校验，仍不会创建任何实体。</p></div><button type="button" className="icon-button" aria-label="关闭 JSON 编辑器" onClick={onClose}><X size={18}/></button></header>
      <textarea aria-label="创意工坊 JSON 草稿" spellCheck={false} value={value} onChange={(event) => { setValue(event.target.value); setError(undefined) }} />
      {error === undefined ? null : <p className="creative-workshop-error" role="alert">{error}</p>}
      <footer>
        <div>
          <button type="button" className="secondary-button" onClick={() => { try { setValue(JSON.stringify(JSON.parse(value), null, 2)); setError(undefined) } catch { setError('JSON 无法格式化，请先修正语法') } }}>格式化</button>
          <button type="button" className="secondary-button" onClick={() => void navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1_500) })}><Copy size={15}/>{copied ? '已复制' : '复制'}</button>
          <button type="button" className="secondary-button" onClick={exportJson}><DownloadSimple size={15}/>导出</button>
          <button type="button" className="secondary-button" onClick={() => inputRef.current?.click()}><FileArrowUp size={15}/>导入</button>
          <input ref={inputRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then(setValue).catch(() => setError('JSON 文件读取失败')); event.currentTarget.value = '' }} />
        </div>
        <div><button type="button" className="text-button" onClick={onClose}>取消</button><button type="button" className="primary-button" onClick={apply}><Check size={15}/>应用到草稿</button></div>
      </footer>
    </section>
  </div>
}

export function portableDraftJson(draft: WorkshopDraft): string {
  return JSON.stringify({
    schemaVersion: 1,
    world: {
      name: draft.displayName,
      description: draft.lore,
      purpose: draft.scenario,
      templateId: draft.baseTemplateId,
      modelPolicy: { mode: 'inherit' },
    },
    characters: draft.roles.map((role) => ({
      tempId: role.clientId,
      name: role.displayName,
      ...(role.role.trim() ? { role: role.role } : {}),
      ...(role.summary.trim() ? { summary: role.summary } : {}),
      ...(role.persona.trim() ? { persona: { background: role.persona } } : {}),
      requestedSkills: role.requestedSkillIds,
      modelPolicy: { mode: 'inherit' },
    })),
  }, null, 2)
}
