import {
  ArrowRight,
  Buildings,
  ChatCircleDots,
  CheckCircle,
  Cube,
  FolderOpen,
  MagnifyingGlass,
  Palette,
  ShieldCheck,
  Storefront,
  Trash,
  UserPlus,
  Warning,
  X,
} from '@phosphor-icons/react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type {
  CyberMarketKind,
  CyberMarketPackage,
  CharacterGeneratorPublishResult,
  CyberPackageManifest,
  InstalledPackage,
  PackageInstallTransaction,
  PackagePermissionPreview,
  World,
} from '@dsh-cyber/contracts'
import { DEFAULT_SKIN_ID } from '../features/world/world-themes.js'
import { useI18n } from '../i18n/runtime.js'
import { useDialogFocusTrap } from './useDialogFocusTrap.js'

const CharacterGenerator = lazy(async () => ({
  default: (await import('./character-generator/CharacterGenerator.js')).CharacterGenerator,
}))

// Official skin packages point at the same host-registered scene used by the
// world switcher. The package catalog remains the source of truth for which
// cards are installable; this map only supplies an honest local thumbnail.
const MARKET_SKIN_PREVIEW_IMAGES: Record<string, string> = {
  'default-skin': '/assets/cyber-office-world-clean.png',
  'maid-atelier': '/assets/skins/maid-palace-night.webp',
  'orca-link': '/assets/skins/orca-bridge-night.png',
  'cyber-company': '/assets/cyber-office-world-clean.png',
  'moonlit-tavern': '/assets/moonlit-tavern-world.png',
  'sakura-shrine': '/assets/skins/sakura-shrine-world.jpg',
  'starlit-witch': '/assets/skins/starlit-witch-world.jpg',
  'neon-cyber': '/assets/skins/neon-cyber-world.jpg',
  'white-whale': '/assets/skins/white-whale-maiden.jpg',
  'black-orca': '/assets/skins/black-orca-maiden.jpg',
}

interface PackageMarketDialogProps {
  workspaceId: string
  initialMarket: CyberMarketKind
  world: World
  worlds: World[]
  items: CyberMarketPackage[]
  installed: InstalledPackage[]
  transactions: PackageInstallTransaction[]
  loading: boolean
  installing: boolean
  currentSkinId?: string
  onApplySkin?(skinId: string): Promise<void> | void
  onClose(): void
  onSearch(market: CyberMarketKind, query: string): Promise<void>
  onPreviewMarketplace(item: CyberMarketPackage): Promise<PackagePermissionPreview>
  onInstallMarketplace(item: CyberMarketPackage, approvalToken: string): Promise<void>
  onUninstall(item: InstalledPackage): Promise<void>
  onOpenSettings(): void
  onCreateThemeWorld(item: CyberMarketPackage, name: string): Promise<void>
  onRecruitTalent(item: CyberMarketPackage): Promise<void>
  onCharacterPublished?(result: CharacterGeneratorPublishResult): Promise<void> | void
  onUsePlugin(command: string): void
  onPreview(manifest: CyberPackageManifest): Promise<PackagePermissionPreview>
  onInstall(input: { manifest: CyberPackageManifest; sourceDirectory: string; approvalToken: string }): Promise<void>
}

export function PackageMarketDialog(props: PackageMarketDialogProps) {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLElement | null>(null)
  const customRoleButtonRef = useRef<HTMLButtonElement | null>(null)
  const restoreCustomRoleFocusRef = useRef(false)
  const marketMeta: Record<CyberMarketKind, { label: string; description: string }> = useMemo(() => ({
    theme: { label: t('workbench.marketTabTheme', '世界'), description: t('workbench.marketTabThemeDesc', '选择完整场景皮肤、空间设定和起始角色，创建彼此独立的新世界。') },
    talent: { label: t('workbench.marketTabTalent', '角色'), description: t('workbench.marketTabTalentDesc', '安装不同世界观与专长的角色模板，再把角色招募到兼容世界。') },
    plugin: { label: t('workbench.marketTabPlugin', '插件'), description: t('workbench.marketTabPluginDesc', '先安装到本地包库，再为需要的世界单独启用；每次安装都可审阅、回滚。') },
    skin: { label: t('workbench.marketTabSkin', '皮肤'), description: t('workbench.marketTabSkinDesc', '安装完整的场景皮肤；安装后才会出现在世界皮肤下拉，默认皮肤始终可用。') },
  }), [t])

  const [market, setMarket] = useState<CyberMarketKind>(props.initialMarket)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<CyberMarketPackage>()
  const [preview, setPreview] = useState<PackagePermissionPreview>()
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState<string>()
  const [manualOpen, setManualOpen] = useState(false)
  const [creatingWorldFor, setCreatingWorldFor] = useState<CyberMarketPackage>()
  const [worldName, setWorldName] = useState('')
  const [creatingWorld, setCreatingWorld] = useState(false)
  const [confirmingUninstall, setConfirmingUninstall] = useState<string>()
  const [customRoleOpen, setCustomRoleOpen] = useState(false)
  const [generatorCloseRequest, setGeneratorCloseRequest] = useState(0)
  const selectedCurrent = selected === undefined
    ? undefined
    : props.items.find((item) => item.manifest.id === selected.manifest.id && item.manifest.version === selected.manifest.version) ?? selected
  const selectedInstalled = selectedCurrent?.installedVersion === selectedCurrent?.manifest.version ? selectedCurrent : undefined
  const selectedInstalledPackage = selectedCurrent === undefined ? undefined : props.installed.find((item) => item.packageId === selectedCurrent.manifest.id && item.status === 'active')

  const closeDialog = () => {
    if (customRoleOpen) {
      setGeneratorCloseRequest((value) => value + 1)
      return
    }
    props.onClose()
  }

  useDialogFocusTrap(dialogRef, closeDialog)

  useEffect(() => {
    setMarket(props.initialMarket)
    setQuery('')
    setSelected(undefined)
    setPreview(undefined)
    setApproved(false)
    setCreatingWorldFor(undefined)
    setCustomRoleOpen(false)
    setGeneratorCloseRequest(0)
  }, [props.initialMarket])

  const switchMarket = (next: CyberMarketKind) => {
    setMarket(next)
    setSelected(undefined)
    setPreview(undefined)
    setApproved(false)
    setError(undefined)
    setCreatingWorldFor(undefined)
    setCustomRoleOpen(false)
    setGeneratorCloseRequest(0)
    void props.onSearch(next, '')
  }

  const search = (event: FormEvent) => {
    event.preventDefault()
    setSelected(undefined)
    setPreview(undefined)
    void props.onSearch(market, query)
  }

  const openCustomRoleGenerator = () => {
    setError(undefined)
    setGeneratorCloseRequest(0)
    setCustomRoleOpen(true)
  }

  const closeCustomRoleGenerator = () => {
    setCustomRoleOpen(false)
    setGeneratorCloseRequest(0)
    // The trigger is unmounted while the generator is open, so remember to put
    // focus back on it once the market catalog returns.
    restoreCustomRoleFocusRef.current = true
  }

  useEffect(() => {
    if (customRoleOpen || !restoreCustomRoleFocusRef.current) return
    restoreCustomRoleFocusRef.current = false
    customRoleButtonRef.current?.focus()
  }, [customRoleOpen, market])

  const completeCustomRolePublish = async (result: CharacterGeneratorPublishResult) => {
    if (props.onCharacterPublished !== undefined) await props.onCharacterPublished(result)
    else await props.onSearch('talent', query)
    setMarket('talent')
    setSelected(undefined)
    setPreview(undefined)
    setApproved(false)
    setCustomRoleOpen(false)
    setGeneratorCloseRequest(0)
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
      setSelected({ ...selected, installedVersion: selected.manifest.version })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '安装失败，原版本已保留')
    }
  }

  const prepareWorld = (item: CyberMarketPackage) => {
    setSelected(item)
    setPreview(undefined)
    setApproved(false)
    setError(undefined)
    setCreatingWorldFor(item)
    setWorldName(item.manifest.displayName.split('·')[0]!.trim())
  }

  const activate = (item: CyberMarketPackage) => {
    setSelected(item)
    setPreview(undefined)
    setApproved(false)
    setError(undefined)
    setCreatingWorldFor(undefined)
    if (item.market === 'skin') {
      const activation = item.activation?.kind === 'skin' ? item.activation : undefined
      const skinId = activation?.themeId ?? (item.manifest.id === 'default-skin' ? DEFAULT_SKIN_ID : item.manifest.id)
      void Promise.resolve(props.onApplySkin?.(skinId)).catch((cause) => setError(cause instanceof Error ? cause.message : '皮肤应用失败'))
    }
  }

  const activateMarketItem = (item: CyberMarketPackage) => {
    if (item.market === 'talent') {
      void props.onRecruitTalent(item).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : '角色招募入口不可用')
      })
      return
    }
    activate(item)
  }

  const createWorld = async () => {
    if (creatingWorldFor === undefined || worldName.trim().length === 0) return
    setError(undefined)
    setCreatingWorld(true)
    try {
      await props.onCreateThemeWorld(creatingWorldFor, worldName.trim())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '世界创建失败，请稍后重试')
    } finally {
      setCreatingWorld(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeDialog()}>
      <section ref={dialogRef} className={`package-market-dialog package-market-dialog--catalog${customRoleOpen ? ' is-character-generator' : ''}`} role="dialog" aria-modal="true" aria-labelledby="package-market-title" aria-describedby="package-market-subtitle">
        <header className="dialog-header package-market-header">
          <div><h2 id="package-market-title">{customRoleOpen ? t('characterGenerator.title', '自定义角色') : t('workbench.marketTitle', '扩展市场')}</h2><p id="package-market-subtitle">{customRoleOpen ? t('characterGenerator.subtitle', '把一段角色描述整理成可审阅、可安装的角色模板。') : t('workbench.marketSubtitle', '先选择世界，再发现角色与插件。所有内容经过完整性校验和事务安装。')}</p></div>
          <button className="icon-button" type="button" data-dialog-initial-focus aria-label={customRoleOpen ? t('characterGenerator.close', '关闭自定义角色') : t('workbench.cancel', '关闭市场')} onClick={closeDialog}><X size={18} aria-hidden="true" /></button>
        </header>
        {customRoleOpen ? (
          <Suspense fallback={<div className="dialog-loading" role="status">{t('characterGenerator.opening', '正在打开角色创建器…')}</div>}>
            <CharacterGenerator
              workspaceId={props.workspaceId}
              targetWorld={props.world}
              closeRequest={generatorCloseRequest}
              onClose={closeCustomRoleGenerator}
              onPublished={completeCustomRolePublish}
            />
          </Suspense>
        ) : (
          <>
        <nav className="market-tabs" aria-label="市场分类">
          <MarketTab market="theme" label={marketMeta.theme.label} active={market === 'theme'} onSelect={switchMarket} />
          <MarketTab market="talent" label={marketMeta.talent.label} active={market === 'talent'} onSelect={switchMarket} />
          <MarketTab market="plugin" label={marketMeta.plugin.label} active={market === 'plugin'} onSelect={switchMarket} />
          <MarketTab market="skin" label={marketMeta.skin.label} active={market === 'skin'} onSelect={switchMarket} />
        </nav>
        <div className="package-market-layout package-market-layout--catalog">
          <main className="market-catalog">
            <div className="market-intro">
              <div>
                <strong>{marketMeta[market].label}</strong>
                <span>{marketMeta[market].description}</span>
              </div>
              <span>{t('workbench.marketExtensionCount', '{count} 个扩展', { count: props.items.length })}</span>
            </div>
            <div className="market-search-row">
              <form className="market-search" onSubmit={search}>
                <MagnifyingGlass size={17} aria-hidden="true" />
                <input id="market-search-input" aria-label={t('workbench.marketSearchSubmit', '搜索')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('workbench.marketSearchPlaceholder', '搜索{category}、发布者或能力', { category: marketMeta[market].label })} />
                <button type="submit">{t('workbench.marketSearchSubmit', '搜索')}</button>
              </form>
              {market === 'talent' ? <button ref={customRoleButtonRef} className="market-custom-role-button" type="button" onClick={openCustomRoleGenerator}><UserPlus size={17} aria-hidden="true" />{t('characterGenerator.title', '自定义角色')}</button> : null}
            </div>
            {error === undefined ? null : <div className="package-error" role="alert"><Warning size={16} />{error}</div>}
            {props.loading ? <div className="dialog-empty">{t('workbench.marketCheckingLocal', '正在校验本地市场目录…')}</div> : props.items.length === 0 ? (
              <div className="market-empty"><Cube size={30} /><strong>{t('workbench.marketEmpty', '没有匹配的扩展')}</strong><span>{t('workbench.marketEmptyDesc', '可以修改关键词，或使用下方“本地导入”安装自定义包。')}</span></div>
            ) : (
              <div className="market-card-grid">
                {props.items.map((item) => {
                  const state = packageCardState(item, props.worlds)
                  const selectedClass = selected?.manifest.id === item.manifest.id ? ' is-selected' : ''
                  return (
                    <article key={`${item.manifest.id}-${item.manifest.version}`} className={`is-${state}${selectedClass}`}>
                      {item.market === 'theme' ? <img className="market-world-cover" src={marketplacePreviewUrl(item, props.workspaceId)} alt={`${item.manifest.displayName}世界预览`} /> : null}
                      {item.market === 'talent' ? <img className="market-role-cover" src={marketplacePreviewUrl(item, props.workspaceId)} alt={`${item.manifest.displayName}角色风格预览`} /> : null}
                      {item.market === 'skin' ? <SkinPreview item={item} /> : null}
                      <header><MarketIcon market={item.market} /><div><strong>{item.manifest.displayName}</strong><span>{item.manifest.publisher} · v{item.manifest.version}</span></div>{item.verified ? <em><ShieldCheck size={14} />官方校验</em> : <em className="is-community">社区包</em>}</header>
                      <p>{item.manifest.summary}</p>
                      {item.market === 'theme' ? <div className="market-world-facts"><span>完整场景皮肤</span><span>专属角色外观</span><span>独立会话与档案</span></div> : null}
                      {item.market === 'talent' ? <div className="market-role-world">适合：{roleWorldLabel(item.activation?.kind === 'employee-blueprint' ? item.activation.worldTemplateId : undefined)}</div> : null}
                      {item.market === 'plugin' ? <div className="market-plugin-scope">按世界启用 · 设置与会话相互隔离</div> : null}
                      {item.market === 'skin' ? <div className="market-plugin-scope">安装后出现在世界皮肤下拉 · 完整场景与聊天样式同步</div> : null}
                      <div className="market-capabilities">{item.manifest.capabilities.slice(0, 4).map((capability) => <code key={capability}>{capabilityLabel(capability)}</code>)}</div>
                      <footer>
                        <span>{packageStateLabel(item, state)}</span>
                        {marketAction(item, state, () => prepareWorld(item), () => void inspect(item), () => activateMarketItem(item))}
                      </footer>
                    </article>
                  )
                })}
              </div>
            )}
            <button className="manual-install-toggle" type="button" onClick={() => setManualOpen((value) => !value)}><FolderOpen size={16} />{manualOpen ? t('workbench.marketManualToggleOpen', '收起本地导入') : t('workbench.marketManualToggleClose', '本地导入自定义包')}</button>
            {manualOpen ? <ManualInstaller installing={props.installing} onPreview={props.onPreview} onInstall={props.onInstall} /> : null}
          </main>
          <aside className="market-review-panel">
            {creatingWorldFor !== undefined
              ? <WorldCreationReview item={creatingWorldFor} workspaceId={props.workspaceId} name={worldName} creating={creatingWorld} onName={setWorldName} onCreate={() => void createWorld()} />
              : selectedCurrent !== undefined && preview !== undefined
                ? <PermissionReview manifest={selectedCurrent.manifest} preview={preview} approved={approved} installing={props.installing} onApproved={setApproved} onInstall={() => void install()} />
                : selectedCurrent?.market === 'skin' && (selectedInstalled !== undefined || selectedCurrent.manifest.id === 'default-skin')
                  ? <SkinActivationReview item={selectedCurrent} currentSkinId={props.currentSkinId} installedPackage={selectedInstalledPackage} installing={props.installing} confirmingUninstall={confirmingUninstall} onConfirmUninstall={setConfirmingUninstall} onUninstall={props.onUninstall} onApplySkin={props.onApplySkin} />
                  : selectedInstalled?.market === 'talent'
                  ? <TalentActivationReview item={selectedInstalled} workspaceId={props.workspaceId} world={props.world} installedPackage={selectedInstalledPackage} installing={props.installing} confirmingUninstall={confirmingUninstall} onConfirmUninstall={setConfirmingUninstall} onUninstall={props.onUninstall} onRecruit={() => props.onRecruitTalent(selectedInstalled)} />
                  : selectedInstalled?.market === 'plugin'
                    ? <PluginActivationReview item={selectedInstalled} installedPackage={selectedInstalledPackage} installing={props.installing} confirmingUninstall={confirmingUninstall} onConfirmUninstall={setConfirmingUninstall} onUninstall={props.onUninstall} onOpenSettings={props.onOpenSettings} onUse={props.onUsePlugin} />
                    : <InstalledOverview installed={props.installed} transactions={props.transactions} installing={props.installing} confirmingUninstall={confirmingUninstall} onConfirmUninstall={setConfirmingUninstall} onUninstall={props.onUninstall} />}
          </aside>
        </div>
          </>
        )}
      </section>
    </div>
  )
}

function MarketTab({ market, label, active, onSelect }: { market: CyberMarketKind; label: string; active: boolean; onSelect(value: CyberMarketKind): void }) {
  return <button className={active ? 'is-active' : ''} type="button" onClick={() => onSelect(market)}><MarketIcon market={market} />{label}</button>
}

function MarketIcon({ market }: { market: CyberMarketKind }) {
  return market === 'theme' ? <Buildings size={18} /> : market === 'talent' ? <Storefront size={18} /> : market === 'skin' ? <Palette size={18} /> : <Cube size={18} />
}

function InstalledOverview({ installed, transactions, installing, confirmingUninstall, onConfirmUninstall, onUninstall }: { installed: InstalledPackage[]; transactions: PackageInstallTransaction[]; installing: boolean; confirmingUninstall?: string | undefined; onConfirmUninstall(packageId?: string): void; onUninstall(item: InstalledPackage): Promise<void> }) {
  const active = installed.filter((item) => item.status === 'active')
  return <div className="installed-overview"><h3>运行中的扩展</h3><p>{active.length} 个活动版本。卸载会同步停用各世界实例，安装文件保留在本机包库中。</p><div className="installed-package-list">{active.length === 0 ? <span className="dialog-empty">尚未安装扩展</span> : active.slice(0, 12).map((item) => <article key={`${item.packageId}-${item.version}`}><span className="package-kind">{packageKindLabel(item.kind)}</span><span className="installed-package-copy"><strong>{item.manifest.displayName}</strong><small>v{item.version}</small></span><PackageRemovalAction item={item} installing={installing} confirming={confirmingUninstall === item.packageId} onConfirm={() => onConfirmUninstall(item.packageId)} onCancel={() => onConfirmUninstall(undefined)} onUninstall={onUninstall} /></article>)}</div><div className="package-history"><strong>最近安装</strong>{transactions.length === 0 ? <span>暂无记录</span> : transactions.slice(0, 6).map((item) => <span key={item.id} className={`transaction-status transaction-status--${item.status}`}>{installed.find((installedItem) => installedItem.packageId === item.packageId)?.manifest.displayName ?? item.packageId} · {transactionLabel(item.status)}</span>)}</div></div>
}

function PackageRemovalAction({ item, installing, confirming, onConfirm, onCancel, onUninstall }: { item: InstalledPackage; installing: boolean; confirming: boolean; onConfirm(): void; onCancel(): void; onUninstall(item: InstalledPackage): Promise<void> }) {
  if (item.kind === 'skin' && item.packageId === 'default-skin') return <span className="package-default-note">默认皮肤</span>
  if (confirming) return <span className="package-removal-confirm"><button className="text-button" type="button" disabled={installing} onClick={onCancel}>取消</button><button className="danger-button" type="button" disabled={installing} onClick={() => void onUninstall(item).finally(onCancel)}>{installing ? '处理中…' : '确认卸载'}</button></span>
  return <button className="text-button package-remove-button" type="button" disabled={installing} onClick={onConfirm}><Trash size={14} />卸载</button>
}

function PermissionReview({ manifest, preview, approved, installing, onApproved, onInstall }: { manifest: CyberPackageManifest; preview: PackagePermissionPreview; approved: boolean; installing: boolean; onApproved(value: boolean): void; onInstall(): void }) {
  return <section className="permission-review permission-review--market"><header><div><span>{packageKindLabel(manifest.kind)}</span><h4>{manifest.displayName} <small>v{manifest.version}</small></h4><p>{manifest.publisher} · {manifest.license}</p></div><CheckCircle size={24} /></header><p>{manifest.summary}</p><PermissionGroup title="新增能力" values={preview.addedCapabilities.map(capabilityLabel)} empty="没有新增能力" tone="warning" /><PermissionGroup title="数据外发" values={preview.dataEgress} empty={manifest.kind === 'skill' ? '发布者声明不外发数据（Skill 的外发声明由发布者负责，运行时不强制）' : '不外发数据'} tone={preview.dataEgress.length > 0 ? 'danger' : manifest.kind === 'skill' ? 'warning' : 'safe'} /><div className="package-file-summary">激活前将再次校验 {manifest.files.length} 个文件与入口定义；失败不会覆盖当前版本。</div><label className="approval-check"><input type="checkbox" checked={approved} onChange={(event) => onApproved(event.target.checked)} /><span>我已审阅发布者、许可证、文件与运行能力。</span></label><button className="primary-button" type="button" disabled={!approved || installing} onClick={onInstall}>{installing ? '正在安装并激活…' : preview.previousVersion ? `批准升级至 v${preview.version}` : `批准安装 v${preview.version}`}</button></section>
}

function WorldCreationReview({ item, workspaceId, name, creating, onName, onCreate }: { item: CyberMarketPackage; workspaceId: string; name: string; creating: boolean; onName(value: string): void; onCreate(): void }) {
  return <section className="world-creation-review">
    <img src={marketplacePreviewUrl(item, workspaceId)} alt={`${item.manifest.displayName}世界预览`} />
    <div><span>已安装的世界皮肤</span><h3>{item.manifest.displayName}</h3><p>{item.manifest.summary}</p></div>
    <ul><li>创建独立世界，不覆盖当前世界</li><li>自动加入三名对应设定的起始角色</li><li>会话、档案、任务和运行状态彼此隔离</li></ul>
    <label className="dialog-field"><span>新世界名称</span><input value={name} maxLength={60} autoFocus onChange={(event) => onName(event.target.value)} placeholder="为这个世界命名" /></label>
    <button className="primary-button" type="button" disabled={creating || name.trim().length === 0} onClick={onCreate}>{creating ? '正在布置世界…' : '创建并进入这个世界'}</button>
  </section>
}

function TalentActivationReview({ item, workspaceId, world, installedPackage, installing, confirmingUninstall, onConfirmUninstall, onUninstall, onRecruit }: { item: CyberMarketPackage; workspaceId: string; world: World; installedPackage?: InstalledPackage | undefined; installing: boolean; confirmingUninstall?: string | undefined; onConfirmUninstall(packageId?: string): void; onUninstall(item: InstalledPackage): Promise<void>; onRecruit(): Promise<void> }) {
  const activation = item.activation?.kind === 'employee-blueprint' ? item.activation : undefined
  const compatible = activation !== undefined && (world.templateId === 'personal-world' || activation.worldTemplateId === world.templateId)
  return <section className="market-activation-review">
    <img src={marketplacePreviewUrl(item, workspaceId)} alt={`${item.manifest.displayName}角色风格预览`} />
    <header><span className="market-activation-review__mark"><UserPlus size={20} /></span><div><span>角色模板已安装</span><h3>{item.manifest.displayName}</h3><p>{item.manifest.summary}</p></div></header>
    <dl><div><dt>目标世界</dt><dd>{world.name}</dd></div><div><dt>适用设定</dt><dd>{roleWorldLabel(activation?.worldTemplateId)}</dd></div></dl>
    {activation === undefined ? <p className="market-activation-review__notice is-warning">模板入口缺少可用的角色定义，请重新安装或检查软件包。</p> : compatible ? <p className="market-activation-review__notice"><CheckCircle size={16} />与当前世界兼容。下一步可确认名字和最小权限，完成后会直接打开私聊。</p> : <p className="market-activation-review__notice is-warning"><Warning size={16} />这名角色属于“{roleWorldLabel(activation.worldTemplateId)}”，请先切换到对应世界再招募。</p>}
    <button className="primary-button" type="button" disabled={!compatible} onClick={() => void onRecruit()}><UserPlus size={17} />选择名字与权限<ArrowRight size={16} /></button>
    {installedPackage === undefined ? null : <PackageRemovalAction item={installedPackage} installing={installing} confirming={confirmingUninstall === installedPackage.packageId} onConfirm={() => onConfirmUninstall(installedPackage.packageId)} onCancel={() => onConfirmUninstall(undefined)} onUninstall={onUninstall} />}
  </section>
}

function PluginActivationReview({ item, installedPackage, installing, confirmingUninstall, onConfirmUninstall, onUninstall, onOpenSettings, onUse }: { item: CyberMarketPackage; installedPackage?: InstalledPackage | undefined; installing: boolean; confirmingUninstall?: string | undefined; onConfirmUninstall(packageId?: string): void; onUninstall(item: InstalledPackage): Promise<void>; onOpenSettings(): void; onUse(command: string): void }) {
  const activation = item.activation?.kind === 'prompt-transform' ? item.activation : undefined
  const commands = activation?.commands ?? []
  const hasFirecrawlSkill = item.manifest.id.toLocaleLowerCase().includes('firecrawl') || item.manifest.entrypoints?.some((entrypoint) => entrypoint.kind === 'skill' && entrypoint.id === 'web.search.firecrawl') === true
  return <section className="market-activation-review market-activation-review--plugin">
    <header><span className="market-activation-review__mark"><ChatCircleDots size={20} /></span><div><span>插件已安装 · 所有世界可用</span><h3>{item.manifest.displayName}</h3><p>{item.manifest.summary}</p></div></header>
    {commands.length > 0 ? <div className="market-command-list"><strong>选择一种用法</strong>{commands.map((command) => <button key={command.trigger} type="button" onClick={() => onUse(command.trigger)}><span><code>{command.trigger}</code><small>{command.description}</small></span><span>带入对话<ArrowRight size={15} /></span></button>)}</div> : activation?.automatic ? <p className="market-activation-review__notice"><CheckCircle size={16} />该插件会自动参与符合条件的对话，无需输入命令。</p> : <p className="market-activation-review__notice is-warning"><Warning size={16} />插件已安装，但没有声明可直接触发的指令。</p>}
    <p className="market-activation-review__footnote">点击后只会把指令带入输入框，你可以补充任务内容并确认。</p>
    {hasFirecrawlSkill ? <button className="secondary-button" type="button" onClick={onOpenSettings}>打开 Firecrawl 设置</button> : null}
    {installedPackage === undefined ? null : <PackageRemovalAction item={installedPackage} installing={installing} confirming={confirmingUninstall === installedPackage.packageId} onConfirm={() => onConfirmUninstall(installedPackage.packageId)} onCancel={() => onConfirmUninstall(undefined)} onUninstall={onUninstall} />}
  </section>
}

type PackageCardState = 'uninstalled' | 'included' | 'upgrade' | 'available' | 'installed' | 'created'

function packageCardState(item: CyberMarketPackage, worlds: World[]): PackageCardState {
  const activation = item.activation
  const hasCreatedWorld = item.market === 'theme' && activation?.kind === 'world-theme' && worlds.some((world) => world.templateId === activation.templateId)
  if (item.market === 'skin' && item.manifest.id === 'default-skin') return 'included'
  if (item.installedVersion === item.manifest.version) {
    if (hasCreatedWorld) return 'created'
    if (item.market === 'skin') return 'installed'
    if (item.market !== 'theme' && item.worldVersion !== item.manifest.version) return 'available'
    return 'installed'
  }
  if (item.installedVersion !== undefined) return 'upgrade'
  if (activation?.kind === 'world-theme' && worlds.some((world) => builtInThemeMatches(world.templateId, activation.templateId))) {
    return 'included'
  }
  return 'uninstalled'
}

function packageStateLabel(item: CyberMarketPackage, state: PackageCardState): string {
  if (state === 'created') return `已安装 v${item.installedVersion} · 已创建`
  if (state === 'installed') {
    const next = item.market === 'theme' ? '可创建' : item.market === 'talent' ? '可招募' : item.market === 'skin' ? '可应用' : '可使用'
    return `已安装 v${item.installedVersion} · ${next}`
  }
  if (state === 'upgrade') return `已安装 v${item.installedVersion} · 有新版 v${item.manifest.version}`
  if (state === 'available') return `包库已有 v${item.installedVersion} · 当前世界未启用`
  if (state === 'included') return item.market === 'skin' ? '默认皮肤 · 始终可用' : '已内置 · 当前可用'
  return '未安装'
}

function marketAction(item: CyberMarketPackage, state: PackageCardState, onBind: () => void, onInspect: () => void, onActivate: () => void) {
  if (item.market === 'theme' && state === 'created') return <button className="market-action--created" type="button" disabled><CheckCircle size={15} />已创建</button>
  if (item.market === 'theme' && state === 'installed') return <button className="market-action--installed" type="button" onClick={onBind}>创建新世界</button>
  if (state === 'installed') return <button className="market-action--installed" type="button" onClick={onActivate}>{item.market === 'talent' ? '招募到世界' : item.market === 'skin' ? '应用到当前世界' : '立即使用'}</button>
  if (item.market === 'skin' && state === 'included') return <button className="market-action--installed" type="button" onClick={onActivate}>应用到当前世界</button>
  if (state === 'available') return <button type="button" onClick={onInspect}>启用到当前世界</button>
  if (state === 'upgrade') return <button className="market-action--upgrade" type="button" onClick={onInspect}>升级到 v{item.manifest.version}</button>
  if (state === 'included') return <button className="market-action--included" type="button" disabled><CheckCircle size={15} />已内置</button>
  return <button type="button" onClick={onInspect}>查看并安装</button>
}

function builtInThemeMatches(worldTemplateId: string, packageTemplateId: string): boolean {
  if (worldTemplateId === packageTemplateId) return true
  if (worldTemplateId === 'personal-world' && packageTemplateId === 'cyber-company') return true
  if (['company', 'cyber-company'].includes(worldTemplateId) && packageTemplateId === 'cyber-company') return true
  if (['tavern', 'moonlit-tavern'].includes(worldTemplateId) && ['tavern', 'moonlit-tavern'].includes(packageTemplateId)) return true
  return false
}

function SkinPreview({ item }: { item: CyberMarketPackage }) {
  const preview = MARKET_SKIN_PREVIEW_IMAGES[item.manifest.id]
  return (
    <div className="market-skin-preview">
      {preview === undefined
        ? <><Palette size={28} /><span>安装后使用该皮肤声明的完整场景</span></>
        : <img src={preview} alt={`${item.manifest.displayName}预览`} loading="lazy" />}
    </div>
  )
}

function SkinActivationReview({
  item,
  currentSkinId,
  installedPackage,
  installing,
  confirmingUninstall,
  onConfirmUninstall,
  onUninstall,
  onApplySkin,
}: {
  item: CyberMarketPackage
  currentSkinId?: string | undefined
  installedPackage?: InstalledPackage | undefined
  installing: boolean
  confirmingUninstall?: string | undefined
  onConfirmUninstall(packageId?: string): void
  onUninstall(item: InstalledPackage): Promise<void>
  onApplySkin?: ((skinId: string) => Promise<void> | void) | undefined
}) {
  const activation = item.activation?.kind === 'skin' ? item.activation : undefined
  const themeId = activation?.themeId ?? (item.manifest.id === 'default-skin' ? DEFAULT_SKIN_ID : item.manifest.id)
  const applied = currentSkinId === themeId
  return (
    <section className="market-activation-review market-activation-review--skin">
      <SkinPreview item={item} />
      <header>
        <span className="market-activation-review__mark"><Palette size={20} /></span>
        <div><span>{item.manifest.id === 'default-skin' ? '默认皮肤 · 始终可用' : '皮肤已安装'}</span><h3>{item.manifest.displayName}</h3><p>{item.manifest.summary}</p></div>
      </header>
      <p className="market-activation-review__notice"><CheckCircle size={16} />完整场景、聊天气泡和文字样式会一起切换，绑定到当前世界。</p>
      <button
        className={applied ? 'market-action--created' : 'primary-button'}
        type="button"
        disabled={applied}
        onClick={() => { void Promise.resolve(onApplySkin?.(themeId)).catch(() => undefined) }}
      >
        {applied ? '✓ 当前正在使用' : '应用到当前世界'}
      </button>
      {installedPackage === undefined || item.manifest.id === 'default-skin' ? null : <PackageRemovalAction item={installedPackage} installing={installing} confirming={confirmingUninstall === installedPackage.packageId} onConfirm={() => onConfirmUninstall(installedPackage.packageId)} onCancel={() => onConfirmUninstall(undefined)} onUninstall={onUninstall} />}
    </section>
  )
}

// Generated characters live in a workspace-private catalog root, so the preview
// endpoint only resolves them when the request names the owning workspace.
function marketplacePreviewUrl(item: CyberMarketPackage, workspaceId: string): string {
  return `/api/marketplace/packages/${encodeURIComponent(item.manifest.id)}/${encodeURIComponent(item.manifest.version)}/preview?workspaceId=${encodeURIComponent(workspaceId)}`
}

function roleWorldLabel(templateId: string | undefined): string {
  return ({
    'tavern': '月影酒馆',
    'creator-studio': '云端创作工坊',
    'orbital-observatory': '远星观测站',
    'ai-academy': 'AI 学院',
    'cyber-company': '赛博公司与通用工作区',
    'personal-world': '个人世界',
  } as Record<string, string>)[templateId ?? ''] ?? '兼容世界'
}

function packageKindLabel(kind: CyberPackageManifest['kind']): string {
  const map: Record<CyberPackageManifest['kind'], string> = {
    plugin: '插件',
    skill: '技能包',
    'model-provider': '模型服务',
    asset: '资产包',
    'employee-blueprint': '角色模板',
    'world-theme': '世界主题',
    skin: '皮肤',
  }
  return map[kind] ?? '扩展包'
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
