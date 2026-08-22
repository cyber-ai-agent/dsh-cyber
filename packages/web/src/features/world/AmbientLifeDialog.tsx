import { PersonSimpleWalk, X } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'

import { api } from '../../api.js'

export interface WorldAmbientLifeSettings {
  worldId: string
  enabled: boolean
  minimumIdleMs: number
  minimumAmbientIntervalMs: number
  breakAfterMs: number
  timeBucketMs: number
  maximumPlansPerTick: number
  updatedAt: string
}

interface AmbientLifeDialogProps {
  worldId: string
  worldName: string
  onClose(): void
}

export function AmbientLifeDialog({ worldId, worldName, onClose }: AmbientLifeDialogProps) {
  const [value, setValue] = useState<WorldAmbientLifeSettings>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api<{ settings: WorldAmbientLifeSettings }>(`/api/worlds/${encodeURIComponent(worldId)}/ambient-life`)
      .then((result) => { if (!cancelled) setValue(result.settings) })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '世界活力设置加载失败') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [worldId])

  const save = async () => {
    if (value === undefined) return
    setSaving(true)
    setSaved(false)
    setError(undefined)
    try {
      const result = await api<{ settings: WorldAmbientLifeSettings }>(`/api/worlds/${encodeURIComponent(worldId)}/ambient-life`, {
        method: 'PUT',
        body: JSON.stringify({
          enabled: value.enabled,
          minimumIdleMs: value.minimumIdleMs,
          minimumAmbientIntervalMs: value.minimumAmbientIntervalMs,
          breakAfterMs: value.breakAfterMs,
          timeBucketMs: value.timeBucketMs,
          maximumPlansPerTick: value.maximumPlansPerTick,
        }),
      })
      setValue(result.settings)
      setSaved(true)
      window.setTimeout(onClose, 500)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '世界活力设置保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop ambient-life-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="ambient-life-dialog" role="dialog" aria-modal="true" aria-labelledby="ambient-life-title">
        <header>
          <span className="ambient-life-dialog__icon"><PersonSimpleWalk size={22} weight="fill" /></span>
          <div>
            <h2 id="ambient-life-title">世界活力 · {worldName}</h2>
            <p>角色只在职责相关区域进行可中断的日常活动。真实任务、用户对话和角色协作始终优先。</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭世界活力设置" onClick={onClose}><X size={18} /></button>
        </header>

        {loading ? <div className="ambient-life-dialog__loading">正在读取当前世界策略…</div> : value === undefined ? <div className="ambient-life-dialog__error">{error ?? '无法读取设置'}</div> : (
          <div className="ambient-life-dialog__body">
            <label className="ambient-life-switch">
              <span><strong>启用有岗位逻辑的日常行为</strong><small>关闭时角色只响应真实任务与对话，不会自行移动。</small></span>
              <input type="checkbox" checked={value.enabled} onChange={(event) => setValue({ ...value, enabled: event.target.checked })} />
            </label>

            <div className="ambient-life-grid">
              <SettingSelect label="空闲多久后开始日常行为" value={value.minimumIdleMs} options={[[30_000, '30 秒'], [60_000, '1 分钟'], [180_000, '3 分钟'], [300_000, '5 分钟']]} onChange={(minimumIdleMs) => setValue({ ...value, minimumIdleMs })} />
              <SettingSelect label="两次日常行为的最短间隔" value={value.minimumAmbientIntervalMs} options={[[180_000, '3 分钟'], [300_000, '5 分钟'], [600_000, '10 分钟'], [900_000, '15 分钟']]} onChange={(minimumAmbientIntervalMs) => setValue({ ...value, minimumAmbientIntervalMs })} />
              <SettingSelect label="连续待命多久可短暂休息" value={value.breakAfterMs} options={[[900_000, '15 分钟'], [1_800_000, '30 分钟'], [3_600_000, '1 小时'], [7_200_000, '2 小时']]} onChange={(breakAfterMs) => setValue({ ...value, breakAfterMs })} />
              <SettingSelect label="单次最多安排几个角色" value={value.maximumPlansPerTick} options={[[1, '1 名'], [2, '2 名'], [3, '3 名'], [5, '5 名']]} onChange={(maximumPlansPerTick) => setValue({ ...value, maximumPlansPerTick })} />
            </div>

            <aside className="ambient-life-dialog__notice">
              <strong>行为边界</strong>
              <span>不会随机全图游走；不会进入职责无关部门；不会占用其他角色的位置；不会把视觉日常活动伪装成真实 Agent 任务。角色之间的对话仍通过真实协作会话执行并沉淀记录。</span>
            </aside>
            {error === undefined ? null : <div className="ambient-life-dialog__error" role="alert">{error}</div>}
          </div>
        )}

        <footer>
          <span>{saved ? '✓ 已保存，世界策略将在下一次调度生效' : '设置仅应用于当前世界'}</span>
          <div>
            <button type="button" className="secondary-button" onClick={onClose}>取消</button>
            <button type="button" className="primary-button" disabled={value === undefined || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存设置'}</button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function SettingSelect({ label, value, options, onChange }: { label: string; value: number; options: Array<[number, string]>; onChange(value: number): void }) {
  return (
    <label className="ambient-life-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}
      </select>
    </label>
  )
}
