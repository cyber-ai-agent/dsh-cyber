import {
  Buildings,
  CheckCircle,
  Cube,
  FolderOpen,
  MagnifyingGlass,
  ShieldCheck,
  Storefront,
  Warning,
  X,
} from '@phosphor-icons/react'
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import type {
  CyberMarketKind,
  CyberMarketPackage,
  CyberPackageManifest,
  InstalledPackage,
  PackageInstallTransaction,
  PackagePermissionPreview,
} from '@dsh-cyber/contracts'
import type { CyberEmployee } from '../types.js'

interface PackageMarketDialogProps {
  initialMarket: CyberMarketKind
  items: CyberMarketPackage[]
  installed: InstalledPackage[]
  transactions: PackageInstallTransaction[]
  employees: CyberEmployee[]
  loading: boolean
  installing: boolean
  onClose(): void
  onSearch(market: CyberMarketKind, query: string): Promise<void>
  onPreviewMarketplace(item: CyberMarketPackage): Promise<PackagePermissionPreview>
  onInstallMarketplace(item: CyberMarketPackage, approvalToken: string): Promise<void>
  onBindTheme(packageId: string): Promise<void>
  onPreview(manifest: CyberPackageManifest): Promise<PackagePermissionPreview>
  onInstall(input: { manifest: CyberPackageManifest; sourceDirectory: string; approvalToken: string }): Promise<void>
}

const MARKET_META: Record<CyberMarketKind, { label: string; description: string }> = {
  theme: { label: '主题', description: '安装世界场景、视觉资源与交互主题，再绑定到兼容世界。' },
  plugin: { label: '插件', description: '为角色增加经过审阅、可回滚的扩展能力。当前可执行边界仍以声明式插件为主。' },
  talent: { label: '角色', description: '安装角色模板与能力请求；安装后可从右侧档案创建独立角色实例。' },
}

export function PackageMarketDialog(props: PackageMarketDialogProps) {
  const [market, setMarket] = useState<CyberMarketKind>(props.initialMarket)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<CyberMarketPackage>()
  const [preview, setPreview] = useState<PackagePermissionPreview>()
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState<string>()
  const [manualOpen, setManualOpen] = useState(false)

  useEffect(() => {
    setMarket(props.initialMarket)
    setQuery('')
    setSelected(undefined)
    setPreview(undefined)
    setApproved(false)
  }, [props.initialMarket])

  const switchMarket = (next: CyberMarketKind) => {
    setMarket(next)
    setSelected(undefined)
    setPreview(undefined)
    setApproved(false)
    setError(undefined)
    void props.onSearch(next, '')
  }

  const search = (event: FormEvent) => {
    event.preventDefault()
    setSelected(undefined)
    setPreview(undefined)
    void props.onSearch(market, query)
  }

  const inspect = async (item: CyberMarketPackage) => {
    setSelected(item)
    setApproved(false)
    setError(undefined)
    try {
      setPreview(await props.onPreviewMarketplace(item))
    } catch (cause) {
      setPreview(undefined)
      setError(cause instanceof Error ? cause.message : '扩展权限读取失败')
    }
  }

  const install = async () => {
    if (selected === undefined || preview === undefined) return
    setError(undefined)
    try {
      await props.onInstallMarketplace(selected, preview.approvalToken)
      setApproved(false)
      setPreview(undefined)
      setSelected(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '安装失败，原版本已保留')
    }
  }

  const bindTheme = async (item: CyberMarketPackage) => {
    setError(undefined)
    try {
      await props.onBindTheme(item.manifest.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '主题与当前世界不兼容')
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <section className="package-market-dialog package-market-dialog--catalog" role="dialog" aria-modal="true" aria-labelledby="package-market-title">
        <header className="dialog-header package-market-header">
          <div><h2 id="package-market-title">市场</h2><p>主题、插件和角色模板统一管理；扩展经过完整性校验、能力审阅和事务安装后才进入运行链路。</p></div>
          <button className="icon-button" type="button" aria-label="关闭市场" onClick={props.onClose}><X size={18} /></button>
        </header>
        <nav className="market-tabs" aria-label="市场分类">
          <MarketTab market="theme" active={market === 'theme'} onSelect={switchMarket} />
          <MarketTab market="plugin" active={market === 'plugin'} onSelect={switchMarket} />
          <MarketTab market="talent" active={market === 'talent'} onSelect={switchMarket} />
        </nav>
        <div className="package-market-layout package-market-layout--catalog">
          <main className="market-catalog">
            <div className="market-intro"><div><strong>{MARKET_META[market].label}</strong><span>{MARKET_META[market].description}</span></div><span>{props.items.length} 个扩展</span></div>
            <form className="market-search" onSubmit={search}>
              <MagnifyingGlass size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索${MARKET_META[market].label}、发布者或能力`} />
              <button type="submit">搜索</button>
            </form>
            {error === undefined ? null : <div className="package-error" role="alert"><Warning size={16} />{error}</div>}
            {props.loading ? <div className="dialog-empty">正在校验本地市场目录…</div> : props.items.length === 0 ? (
              <div className="market-empty"><Cube size={30} /><strong>没有匹配的扩展</strong><span>可以修改关键词，或使用下方“本地导入”安装自定义包。</span></div>
            ) : (
              <div className="market-card-grid">
                {props.items.map((item) => (
                  <article key={`${item.manifest.id}-${item.manifest.version}`} className={selected?.manifest.id === item.manifest.id ? 'is-selected' : ''}>
                    <header><MarketIcon market={item.market} /><div><strong>{item.manifest.displayName}</strong><span>{item.manifest.publisher} · v{item.manifest.version}</span></div>{item.verified ? <em><ShieldCheck size={14} />官方校验</em> : <em className="is-community">社区包</em>}</header>
                    <p>{item.manifest.summary}</p>
                    <div className="market-capabilities">{item.manifest.capabilities.slice(0, 4).map((capability) => <code key={capability}>{capabilityLabel(capability)}</code>)}</div>
                    <footer>
                      <span>{item.installedVersion === undefined ? '未安装' : `已安装 v${item.installedVersion}`}</span>
                      {marketAction(item, () => void bindTheme(item), () => void inspect(item))}
                    </footer>
                  </article>
                ))}
              </div>
            )}
            <button className="manual-install-toggle" type="button" onClick={() => setManualOpen((value) => !value)}><FolderOpen size={16} />{manualOpen ? '收起本地导入' : '本地导入自定义包'}</button>
            {manualOpen ? <ManualInstaller installing={props.installing} onPreview={props.onPreview} onInstall={props.onInstall} /> : null}
          </main>
          <aside className="market-review-panel">
            {selected === undefined || preview === undefined
              ? <InstalledOverview installed={props.installed} transactions={props.transactions} />
              : <PermissionReview manifest={selected.manifest} preview={preview} approved={approved} installing={props.installing} onApproved={setApproved} onInstall={() => void install()} />}
          </aside>
        </div>
      </section>
    </div>
  )
}

function MarketTab({ market, active, onSelect }: { market: CyberMarketKind; active: boolean; onSelect(value: CyberMarketKind): void }) {
  return <button className={active ? 'is-active' : ''} type="button" onClick={() => onSelect(market)}><MarketIcon market={market} />{MARKET_META[market].label}</button>
}

function MarketIcon({ market }: { market: CyberMarketKind }) {
  return market === 'theme' ? <Buildings size={18} /> : market === 'talent' ? <Storefront size={18} /> : <Cube size={18} />
}

function InstalledOverview({ installed, transactions }: { installed: InstalledPackage[]; transactions: PackageInstallTransaction[] }) {
  const active = installed.filter((item) => item.status === 'active')
  return <div className="installed-overview"><h3>运行中的扩展</h3><p>{active.length} 个活动版本。所有变更均保留安装事务，失败自动回滚。</p><div className="installed-package-list">{active.length === 0 ? <span className="dialog-empty">尚未安装扩展</span> : active.slice(0, 8).map((item) => <article key={`${item.packageId}-${item.version}`}><span className="package-kind">{packageKindLabel(item.kind)}</span><strong>{item.manifest.displayName}</strong><small>v{item.version}</small></article>)}</div><div className="package-history"><strong>最近安装</strong>{transactions.length === 0 ? <span>暂无记录</span> : transactions.slice(0, 6).map((item) => <span key={item.id} className={`transaction-status transaction-status--${item.status}`}>{installed.find((installedItem) => installedItem.packageId === item.packageId)?.manifest.displayName ?? item.packageId} · {transactionLabel(item.status)}</span>)}</div></div>
}

function PermissionReview({ manifest, preview, approved, installing, onApproved, onInstall }: { manifest: CyberPackageManifest; preview: PackagePermissionPreview; approved: boolean; installing: boolean; onApproved(value: boolean): void; onInstall(): void }) {
  return <section className="permission-review permission-review--market"><header><div><span>{packageKindLabel(manifest.kind)}</span><h4>{manifest.displayName} <small>v{manifest.version}</small></h4><p>{manifest.publisher} · {manifest.license}</p></div><CheckCircle size={24} /></header><p>{manifest.summary}</p><PermissionGroup title="新增能力" values={preview.addedCapabilities.map(capabilityLabel)} empty="没有新增能力" tone="warning" /><PermissionGroup title="数据外发" values={preview.dataEgress} empty="不外发数据" tone={preview.dataEgress.length > 0 ? 'danger' : 'safe'} /><div className="package-file-summary">激活前将再次校验 {manifest.files.length} 个文件与入口定义；失败不会覆盖当前版本。</div><label className="approval-check"><input type="checkbox" checked={approved} onChange={(event) => onApproved(event.target.checked)} /><span>我已审阅发布者、许可证、文件与运行能力。</span></label><button className="primary-button" type="button" disabled={!approved || installing} onClick={onInstall}>{installing ? '正在安装并激活…' : preview.previousVersion ? `批准升级至 v${preview.version}` : `批准安装 v${preview.version}`}</button></section>
}

function marketAction(item: CyberMarketPackage, onBind: () => void, onInspect: () => void) {
  const installed = item.installedVersion === item.manifest.version
  if (item.market === 'theme' && installed) return <button type="button" onClick={onBind}>绑定到当前世界</button>
  if (installed) return <button type="button" disabled>已安装</button>
  return <button type="button" onClick={onInspect}>{item.installedVersion === undefined ? '查看并安装' : '查看升级'}</button>
}

function packageKindLabel(kind: CyberPackageManifest['kind']): string {
  return ({ plugin: '插件', skill: '技能包', 'model-provider': '模型服务', asset: '资产包', 'employee-blueprint': '角色模板', 'world-theme': '世界主题' })[kind]
}

function capabilityLabel(capability: string): string {
  return ({
    'employee:blueprint': '提供角色模板',
    'workspace:read': '读取本地工作目录',
    'knowledge:read': '读取知识库',
    'artifact:read': '读取产物',
    'prompt:transform': '调整运行提示',
    'world:render': '渲染世界',
  } as Record<string, string>)[capability] ?? capability
}

function ManualInstaller({ installing, onPreview, onInstall }: { installing: boolean; onPreview(manifest: CyberPackageManifest): Promise<PackagePermissionPreview>; onInstall(input: { manifest: CyberPackageManifest; sourceDirectory: string; approvalToken: string }): Promise<void> }) {
  const [manifestText, setManifestText] = useState('')
  const [sourceDirectory, setSourceDirectory] = useState('')
  const [manifest, setManifest] = useState<CyberPackageManifest>()
  const [preview, setPreview] = useState<PackagePermissionPreview>()
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState<string>()
  const loadManifest = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file === undefined) return; setManifestText(await file.text()); setPreview(undefined); setApproved(false); event.target.value = '' }
  const inspect = async () => { try { const parsed = JSON.parse(manifestText) as CyberPackageManifest; setManifest(parsed); setPreview(await onPreview(parsed)); setError(undefined) } catch (cause) { setError(cause instanceof Error ? cause.message : '清单无法解析') } }
  const install = async () => { if (manifest === undefined || preview === undefined) return; try { await onInstall({ manifest, sourceDirectory: sourceDirectory.trim(), approvalToken: preview.approvalToken }); setPreview(undefined); setApproved(false); setError(undefined) } catch (cause) { setError(cause instanceof Error ? cause.message : '安装失败') } }
  return <section className="manual-installer"><label className="manifest-file-button"><input type="file" accept="application/json,.json" onChange={(event) => void loadManifest(event)} /><FolderOpen size={16} />选择 dsh-cyber.package.json</label><label className="dialog-field"><span>软件包清单</span><textarea rows={6} value={manifestText} onChange={(event) => { setManifestText(event.target.value); setPreview(undefined) }} /></label><label className="dialog-field"><span>本机软件包目录</span><input value={sourceDirectory} onChange={(event) => setSourceDirectory(event.target.value)} placeholder="F:\\packages\\my-extension" /></label><button className="secondary-button" type="button" disabled={!manifestText.trim() || installing} onClick={() => void inspect()}><ShieldCheck size={15} />检查清单</button>{error === undefined ? null : <div className="package-error"><Warning size={16} />{error}</div>}{preview === undefined ? null : <><label className="approval-check"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} />批准 {preview.addedCapabilities.length} 项新增能力</label><button className="primary-button" type="button" disabled={!approved || !sourceDirectory.trim() || installing} onClick={() => void install()}>安装本地包</button></>}</section>
}

function PermissionGroup({ title, values, empty, tone }: { title: string; values: string[]; empty: string; tone?: 'safe' | 'warning' | 'danger' }) {
  return <div className={`permission-group${tone === undefined ? '' : ` permission-group--${tone}`}`}><strong>{title}</strong><div>{values.length === 0 ? <span>{empty}</span> : values.map((value) => <code key={value}>{value}</code>)}</div></div>
}

function transactionLabel(status: PackageInstallTransaction['status']): string {
  return ({ pending: '待处理', approved: '已批准', staged: '已暂存', activated: '已激活', failed: '失败', 'rolled-back': '已回滚' })[status]
}
