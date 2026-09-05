import { Buildings } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { WorldTemplateManifest } from '@dsh-cyber/contracts'
import { api } from '../api.js'
import './BuiltinWorldMarket.css'

/**
 * Core templates ship with the application and are already available; creating
 * a world from one writes no installed package and runs no install
 * transaction. The card therefore reads the same way an installed theme card
 * does — an icon, a provenance line, a state line and one action — while its
 * state line says plainly that nothing is installed. "Available" must never be
 * dressed up as a completed install.
 */
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
  return <section aria-label="内置世界模板" className="builtin-world-market market-section">
    <header className="market-intro"><div><strong>内置世界模板</strong><span>随应用提供，创建后可直接进入；不产生安装事务，也不会出现在已安装扩展里。成员在角色档案中添加。</span></div><span>{filtered.length} 个模板</span></header>
    {error === undefined ? null : <div className="package-error" role="alert">{error}<button type="button" onClick={() => setRevision((value) => value + 1)}>重新读取</button></div>}
    {loading ? <p role="status">正在读取内置世界…</p> : <div className="market-card-grid">
      {filtered.map((template) => <article key={template.id} className={selected === template.id ? 'is-selected' : ''}>
        <header><Buildings size={20} aria-hidden="true" /><div><strong>{template.displayName}</strong><span>随应用提供 · 内置模板</span></div></header>
        <p>{template.summary}</p>
        <footer><span className="market-card-state">无需安装 · 可直接创建</span><button type="button" disabled={creating} onClick={() => { setSelected(template.id); setName(template.displayName) }}>选择{template.displayName}</button></footer>
        {selected === template.id ? <form onSubmit={(event) => { event.preventDefault(); void create() }}>
          <label className="dialog-field"><span>世界名称</span><input aria-label="新世界名称" value={name} maxLength={80} disabled={creating} onChange={(event) => setName(event.target.value)} /></label>
          <button className="primary-button" type="submit" disabled={creating || !name.trim()}>{creating ? '正在创建…' : '创建并进入'}</button>
        </form> : null}
      </article>)}
    </div>}
  </section>
}
