import {
  CheckCircle,
  Cube,
  FolderOpen,
  ShieldCheck,
  Warning,
  X,
} from '@phosphor-icons/react'
import { useMemo, useState, type ChangeEvent } from 'react'
import type {
  CyberPackageManifest,
  InstalledPackage,
  PackageInstallTransaction,
  PackagePermissionPreview,
} from '@dsh-cyber/contracts'

interface PackageMarketDialogProps {
  installed: InstalledPackage[]
  transactions: PackageInstallTransaction[]
  loading: boolean
  installing: boolean
  onClose(): void
  onPreview(manifest: CyberPackageManifest): Promise<PackagePermissionPreview>
  onInstall(input: { manifest: CyberPackageManifest; sourceDirectory: string; approvalToken: string }): Promise<void>
}

export function PackageMarketDialog({ installed, transactions, loading, installing, onClose, onPreview, onInstall }: PackageMarketDialogProps) {
  const [manifestText, setManifestText] = useState('')
  const [sourceDirectory, setSourceDirectory] = useState('')
  const [manifest, setManifest] = useState<CyberPackageManifest>()
  const [preview, setPreview] = useState<PackagePermissionPreview>()
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState<string>()
  const latestTransactions = useMemo(() => transactions.slice(0, 8), [transactions])

  const loadManifest = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file === undefined) return
    setManifestText(await file.text())
    setPreview(undefined)
    setApproved(false)
    setError(undefined)
    event.target.value = ''
  }

  const inspect = async () => {
    setError(undefined)
    setApproved(false)
    try {
      const parsed = JSON.parse(manifestText) as CyberPackageManifest
      const result = await onPreview(parsed)
      setManifest(parsed)
      setPreview(result)
    } catch (cause) {
      setManifest(undefined)
      setPreview(undefined)
      setError(cause instanceof Error ? cause.message : '软件包清单无法解析')
    }
  }

  const install = async () => {
    if (manifest === undefined || preview === undefined) return
    setError(undefined)
    try {
      await onInstall({ manifest, sourceDirectory: sourceDirectory.trim(), approvalToken: preview.approvalToken })
      setApproved(false)
      setPreview(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '软件包安装失败，已回滚')
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="package-market-dialog" role="dialog" aria-modal="true" aria-labelledby="package-market-title">
        <header className="dialog-header">
          <div><h2 id="package-market-title">软件包市场</h2><p>接入插件、技能、角色蓝图、世界主题与模型提供商；本地安装必须先审阅权限。</p></div>
          <button className="icon-button" type="button" aria-label="关闭软件包市场" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="package-market-layout">
          <aside className="package-inventory">
            <div className="settings-section__heading"><h3><Cube size={17} />已安装软件包</h3><p>{installed.length} 个活动版本，升级失败会恢复此前版本。</p></div>
            {loading ? <div className="dialog-empty">正在读取本地软件包…</div> : installed.length === 0 ? <div className="dialog-empty">尚未安装扩展，核心功能可完全离线运行。</div> : (
              <div className="installed-package-list">
                {installed.map((item) => (
                  <article key={`${item.packageId}-${item.version}`}>
                    <span className="package-kind">{item.kind}</span>
                    <strong>{item.manifest.displayName}</strong>
                    <p>{item.manifest.summary}</p>
                    <small>{item.packageId} · v{item.version}</small>
                  </article>
                ))}
              </div>
            )}
            <div className="package-history">
              <strong>最近安装事务</strong>
              {latestTransactions.length === 0 ? <span>暂无记录</span> : latestTransactions.map((item) => (
                <span key={item.id} className={`transaction-status transaction-status--${item.status}`}>{item.packageId} · {transactionLabel(item.status)}</span>
              ))}
            </div>
          </aside>
          <main className="package-installer">
            <div className="settings-section__heading"><h3><FolderOpen size={17} />从本机安装</h3><p>选择软件包清单并填写其解压目录。清单、文件哈希和权限批准完全匹配后才会激活。</p></div>
            <label className="manifest-file-button">
              <input type="file" accept="application/json,.json" onChange={(event) => void loadManifest(event)} />
              <FolderOpen size={16} />选择 cyber.package.json
            </label>
            <label className="dialog-field"><span>软件包清单</span><textarea rows={9} value={manifestText} onChange={(event) => { setManifestText(event.target.value); setPreview(undefined); setApproved(false) }} placeholder="粘贴或选择经过发布者签发的 CyberPackageManifest JSON" /></label>
            <label className="dialog-field"><span>本机软件包目录</span><input value={sourceDirectory} onChange={(event) => setSourceDirectory(event.target.value)} placeholder="例如 F:\\packages\\my-cyber-skill" /></label>
            <button className="secondary-button" type="button" disabled={!manifestText.trim() || installing} onClick={() => void inspect()}><ShieldCheck size={15} />检查清单与权限</button>
            {error === undefined ? null : <div className="package-error" role="alert"><Warning size={16} />{error}</div>}
            {preview === undefined || manifest === undefined ? null : (
              <section className="permission-review" aria-label="软件包权限审阅">
                <header><div><span>{manifest.kind}</span><h4>{manifest.displayName} <small>v{manifest.version}</small></h4><p>{manifest.publisher} · {manifest.license}</p></div><CheckCircle size={24} /></header>
                <p>{manifest.summary}</p>
                <PermissionGroup title="新增能力" values={preview.addedCapabilities} empty="没有新增能力" tone="warning" />
                <PermissionGroup title="移除能力" values={preview.removedCapabilities} empty="没有移除能力" />
                <PermissionGroup title="数据外发" values={preview.dataEgress} empty="清单声明不外发数据" tone={preview.dataEgress.length > 0 ? 'danger' : 'safe'} />
                <div className="package-file-summary">将校验 {manifest.files.length} 个文件的 SHA-256；目标版本激活前不会覆盖当前活动版本。</div>
                <label className="approval-check"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} /><span>我已审阅发布者、许可证、文件和以上权限，批准此次安装。</span></label>
                <button className="primary-button" type="button" disabled={!approved || !sourceDirectory.trim() || installing} onClick={() => void install()}>{installing ? '正在校验并安装…' : preview.previousVersion ? `批准升级 ${preview.previousVersion} → ${preview.version}` : `批准安装 v${preview.version}`}</button>
              </section>
            )}
          </main>
        </div>
      </section>
    </div>
  )
}

function PermissionGroup({ title, values, empty, tone }: { title: string; values: string[]; empty: string; tone?: 'safe' | 'warning' | 'danger' }) {
  return <div className={`permission-group${tone === undefined ? '' : ` permission-group--${tone}`}`}><strong>{title}</strong><div>{values.length === 0 ? <span>{empty}</span> : values.map((value) => <code key={value}>{value}</code>)}</div></div>
}

function transactionLabel(status: PackageInstallTransaction['status']): string {
  return ({ approved: '已批准', staged: '已暂存', activated: '已激活', 'rolled-back': '已回滚', failed: '失败' })[status]
}
