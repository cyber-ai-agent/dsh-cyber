import { Buildings } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { WorldTemplateManifest } from '@dsh-cyber/contracts'
import { api } from '../api.js'
import './BuiltinWorldMarket.css'

/** Core templates are already available, independently of package installation. */
export function BuiltinWorldMarket({ query, onCreate }: {
  query: string
  onCreate(templateId: string, name: string): Promise<void>
}) {
  const [templates, setTemplates] = useState<WorldTemplateManifest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<string>()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(undefined)
    void api<{ items: WorldTemplateManifest[] }>('/api/catalog/world-templates').then((result) => {
      if (active) setTemplates(result.items)
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : '内置世界读取失败')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [revision])
  const filtered = templates.filter((item) => `${item.displayName} ${item.summary}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const create = async () => {
    if (creating || selected === undefined || !name.trim()) return
    setCreating(true)
    setError(undefined)
    try { await onCreate(selected, name.trim()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '世界创建失败，请重试') }
    finally { setCreating(false) }
  }
  return <section aria-label="内置世界模板" className="builtin-world-market">
    <header className="market-intro"><div><strong>内置世界</strong><span>已随应用提供，可直接创建；在角色档案中添加成员。</span></div><span>{filtered.length} 个模板</span></header>
    {error === undefined ? null : <div className="package-error" role="alert">{error}<button type="button" onClick={() => setRevision((value) => value + 1)}>重新读取</button></div>}
    {loading ? <p role="status">正在读取内置世界…</p> : <div className="market-card-grid">
      {filtered.map((template) => <article key={template.id} className={selected === template.id ? 'is-selected' : ''}>
        <header><Buildings size={20} aria-hidden="true" /><div><strong>{template.displayName}</strong><span>内置模板</span></div></header>
        <p>{template.summary}</p>
        <footer><span>可直接创建</span><button type="button" disabled={creating} onClick={() => { setSelected(template.id); setName(template.displayName) }}>选择{template.displayName}</button></footer>
        {selected === template.id ? <form onSubmit={(event) => { event.preventDefault(); void create() }}>
          <label className="dialog-field"><span>世界名称</span><input aria-label="新世界名称" value={name} maxLength={80} disabled={creating} onChange={(event) => setName(event.target.value)} /></label>
          <button className="primary-button" type="submit" disabled={creating || !name.trim()}>{creating ? '正在创建…' : '创建并进入'}</button>
        </form> : null}
      </article>)}
    </div>}
  </section>
}
