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
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import type {
  CyberMarketKind,
  CyberMarketPackage,
  CyberPackageManifest,
  InstalledPackage,
  PackageInstallTransaction,
  PackagePermissionPreview,
  World,
} from '@dsh-cyber/contracts'

export const MARKET_SKIN_PACKAGES = [
  {
    id: 'maid-atelier',
    displayName: '深海女仆工坊 (Maid Atelier · 鲸鱼娘)',
    publisher: 'Small-tailqwq · 上善 / ZipZipPipe',
    version: '2.0.0',
    summary: '深海女仆工坊经典系列：深海幽蓝波纹、双女仆蕾丝深海蓝界面、半透气泡波纹与深海微光粒子。',
    colors: ['#070e17', '#0f1c30', '#38bdf8', '#7dd3fc'],
    tags: ['深海鲸鱼娘', '双女仆壁纸', '深海蕾丝', '日夜双模'],
  },
  {
    id: 'orca-link',
    displayName: '虎鲸链路 (Orca Link · 虎鲸娘)',
    publisher: 'Small-tailqwq · 上善',
    version: '2.0.0',
    summary: '虎鲸娘机械系列：珍珠白航行机械舱、电蓝链路信号纹理、深海航行数据流与 HUD 机能透光。',
    colors: ['#0b1118', '#142232', '#0284c7', '#38bdf8'],
    tags: ['虎鲸娘', '机械航行舱', '电蓝链路', '机能HUD'],
  },
  {
    id: 'zzz-miyabi',
    displayName: '绝区零 · 星见雅 (ZZZ Miyabi)',
    publisher: 'whyihaveyou · DSH Themes',
    version: '2.0.0',
    summary: '对魔特务六课极霜冰蓝、水墨拔刀斩击光痕与高对比赛博黑曜石，凌冽冷艳刀客风。',
    colors: ['#06090e', '#0f1622', '#00f0ff', '#67e8f9'],
    tags: ['绝区零', '对魔六课', '极霜冰蓝', '水墨拔刀'],
  },
  {
    id: 'zzz-ellen',
    displayName: '绝区零 · 艾莲 (ZZZ Ellen)',
    publisher: 'whyihaveyou · DSH Themes',
    version: '2.0.0',
    summary: '维多利亚家政黑白双拼女仆、朋克绯红鲨鱼齿纹理与暗黑甜酷光晕，剪刀鲨女仆专属质感。',
    colors: ['#0d0a0d', '#1c141e', '#f43f5e', '#fb7185'],
    tags: ['绝区零', '维多利亚家政', '黑白双拼', '暗黑甜酷'],
  },
  {
    id: 'first-love',
    displayName: '初恋时刻 (First Love)',
    publisher: 'SpringBrand · DSH Skin Universe',
    version: '2.0.0',
    summary: '电影感治愈肖像，日系清晨自然光滤镜与清透水润毛玻璃面板，淡粉樱花柔光光晕与晨曦微风。',
    colors: ['#0f0d14', '#1e182a', '#ff7597', '#ffa3b8'],
    tags: ['治愈系', '日系电影感', '清透水润玻璃', '粉樱晨光'],
  },
  {
    id: 'spider-verse',
    displayName: '蛛网都市 (Spider Verse)',
    publisher: 'SpringBrand · DSH Skin Universe',
    version: '2.0.0',
    summary: '纽约赛博高空夜景，经典电光绯红与次元蓝撞色，高空蛛网 HUD 激光线与暗黑半透晶体。',
    colors: ['#070910', '#101626', '#ef4444', '#38bdf8'],
    tags: ['赛博高空', '红蓝撞色', '蛛网透视', '霓虹HUD'],
  },
  {
    id: 'pokemon-sunset',
    displayName: '宝可梦黄昏 (Pokemon Sunset)',
    publisher: 'SpringBrand · DSH Skin Universe',
    version: '2.0.0',
    summary: '金色原野与旅途夕阳氛围，琥珀暖金暮霞与地平线余晖，带来温暖、治愈而沉浸的冒险质感。',
    colors: ['#140d09', '#261811', '#f59e0b', '#fbbf24'],
    tags: ['原野夕阳', '暖金暮霞', '治愈冒险', '琥珀光晕'],
  },
  {
    id: 'naruto-konoha',
    displayName: '木叶忍界 (Naruto Konoha)',
    publisher: 'SpringBrand · DSH Skin Universe',
    version: '2.0.0',
    summary: '火之意志与木叶火影岩黄昏，深炭黑钛装甲切角、查克拉金橙呼吸灯与水墨战术卷轴质感。',
    colors: ['#110d08', '#231810', '#ea580c', '#f97316'],
    tags: ['火之意志', '木叶黄昏', '深炭黑金', '战术卷轴'],
  },
  {
    id: 'demon-slayer-night',
    displayName: '鬼灭藤夜 (Demon Slayer Night)',
    publisher: 'SpringBrand · DSH Skin Universe',
    version: '2.0.0',
    summary: '幽邃深靛紫夜，紫藤花弥散光尘与月下水墨刀光流线，搭配深靛紫晶半透面板与羽织微光。',
    colors: ['#090712', '#17132a', '#a855f7', '#c084fc'],
    tags: ['幽邃紫夜', '紫藤花流光', '水墨刀影', '暗夜紫晶'],
  },
  {
    id: 'cyber-graphite',
    displayName: '赛博霓虹 2.0 (Cyberpunk Horizon)',
    publisher: 'DSH Official',
    version: '2.0.0',
    summary: '黑曜石深空底色搭配赛博电光青流光与全息网格，打造顶尖未来科幻与赛博朋克指挥终端。',
    colors: ['#080c12', '#121924', '#00e5ff', '#38bdf8'],
    tags: ['黑曜石深空', '电光青霓虹', '全息网格', '科幻终端'],
  },
  {
    id: 'linear-obsidian',
    displayName: '极简黑曜 (Linear Obsidian Pro)',
    publisher: 'DSH Official',
    version: '2.0.0',
    summary: '对标 Linear / Raycast / Cursor 顶级工程美学，极致克制深灰黑、1px 细微高光与极高阅读效率。',
    colors: ['#0d0f12', '#181c22', '#5e6ad2', '#34d399'],
    tags: ['现代工程美学', 'Linear 极简', '1px 倒角光', '生产力优先'],
  },
  {
    id: 'paper-daylight',
    displayName: '暖阳白昼 (Claude Warm Daylight)',
    publisher: 'DSH Official',
    version: '2.0.0',
    summary: '对标 Claude / Notion 现代日间质感，温润羊皮纸奶油白搭配茶金点缀，长时间文字交互极其舒适护眼。',
    colors: ['#f5f2eb', '#f0ece1', '#926315', '#15803d'],
    tags: ['羊皮纸暖白', '护眼舒适', '大地色系', 'Claude 风格'],
  },
] as const

interface PackageMarketDialogProps {
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
  onUsePlugin(command: string): void
  onPreview(manifest: CyberPackageManifest): Promise<PackagePermissionPreview>
  onInstall(input: { manifest: CyberPackageManifest; sourceDirectory: string; approvalToken: string }): Promise<void>
}

const MARKET_META: Record<CyberMarketKind, { label: string; description: string }> = {
  theme: { label: '世界', description: '选择完整场景皮肤、空间设定和起始角色，创建彼此独立的新世界。' },
  talent: { label: '角色', description: '安装不同世界观与专长的角色模板，再把角色招募到兼容世界。' },
  plugin: { label: '插件', description: '先安装到本地包库，再为需要的世界单独启用；每次安装都可审阅、回滚。' },
  skin: { label: '皮肤', description: '一键应用现代高颜值 UI 主题与配色体系，自由切换赛博霓虹、极简黑曜、极光星云等风格。' },
}

export function PackageMarketDialog(props: PackageMarketDialogProps) {
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
  const selectedCurrent = selected === undefined
    ? undefined
    : props.items.find((item) => item.manifest.id === selected.manifest.id && item.manifest.version === selected.manifest.version) ?? selected
  const selectedInstalled = selectedCurrent?.installedVersion === selectedCurrent?.manifest.version ? selectedCurrent : undefined
  const selectedInstalledPackage = selectedCurrent === undefined ? undefined : props.installed.find((item) => item.packageId === selectedCurrent.manifest.id && item.status === 'active')

  useEffect(() => {
    setMarket(props.initialMarket)
    setQuery('')
    setSelected(undefined)
    setPreview(undefined)
    setApproved(false)
    setCreatingWorldFor(undefined)
  }, [props.initialMarket])

  const switchMarket = (next: CyberMarketKind) => {
    setMarket(next)
    setSelected(undefined)
    setPreview(undefined)
    setApproved(false)
    setError(undefined)
    setCreatingWorldFor(undefined)
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
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <section className="package-market-dialog package-market-dialog--catalog" role="dialog" aria-modal="true" aria-labelledby="package-market-title">
        <header className="dialog-header package-market-header">
          <div><h2 id="package-market-title">扩展市场</h2><p>先选择世界，再发现角色与插件。所有内容经过完整性校验和事务安装。</p></div>
          <button className="icon-button" type="button" aria-label="关闭市场" onClick={props.onClose}><X size={18} /></button>
        </header>
        <nav className="market-tabs" aria-label="市场分类">
          <MarketTab market="theme" active={market === 'theme'} onSelect={switchMarket} />
          <MarketTab market="talent" active={market === 'talent'} onSelect={switchMarket} />
          <MarketTab market="plugin" active={market === 'plugin'} onSelect={switchMarket} />
          <MarketTab market="skin" active={market === 'skin'} onSelect={switchMarket} />
        </nav>
        <div className="package-market-layout package-market-layout--catalog">
          <main className="market-catalog">
            <div className="market-intro">
              <div>
                <strong>{MARKET_META[market].label}</strong>
                <span>{MARKET_META[market].description}</span>
              </div>
              <span>{market === 'skin' ? MARKET_SKIN_PACKAGES.length : props.items.length} 个扩展</span>
            </div>
            <form className="market-search" onSubmit={search}>
              <MagnifyingGlass size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索${MARKET_META[market].label}、发布者或能力`} />
              <button type="submit">搜索</button>
            </form>
            {error === undefined ? null : <div className="package-error" role="alert"><Warning size={16} />{error}</div>}
            {market === 'skin' ? (
              <div className="market-card-grid">
                {MARKET_SKIN_PACKAGES
                  .filter((skin) => query.trim() === '' || skin.displayName.toLowerCase().includes(query.toLowerCase()) || skin.summary.toLowerCase().includes(query.toLowerCase()) || skin.tags.some((t) => t.toLowerCase().includes(query.toLowerCase())))
                  .map((skin) => {
                    const isActive = (props.currentSkinId ?? 'cyber-graphite') === skin.id
                    return (
                      <article key={skin.id} className={isActive ? 'is-created is-selected' : ''}>
                        <div className="market-skin-preview">
                          <div className="market-skin-palette">
                            {skin.colors.map((color, idx) => (
                              <span key={idx} style={{ background: color }} title={color} />
                            ))}
                          </div>
                        </div>
                        <header>
                          <Palette size={20} />
                          <div>
                            <strong>{skin.displayName}</strong>
                            <span>{skin.publisher} · v{skin.version}</span>
                          </div>
                          <em><ShieldCheck size={14} />官方主题</em>
                        </header>
                        <p>{skin.summary}</p>
                        <div className="market-capabilities">
                          {skin.tags.map((tag) => <code key={tag}>{tag}</code>)}
                        </div>
                        <footer>
                          <span>{isActive ? '当前已应用' : '可用主题'}</span>
                          <button
                            type="button"
                            className={isActive ? 'market-action--created' : 'primary-button'}
                            disabled={isActive}
                            onClick={() => {
                              document.documentElement.dataset.skin = skin.id
                              void props.onApplySkin?.(skin.id)
                            }}
                          >
                            {isActive ? '✓ 正在使用' : '立即换肤'}
                          </button>
                        </footer>
                      </article>
                    )
                  })}
              </div>
            ) : props.loading ? <div className="dialog-empty">正在校验本地市场目录…</div> : props.items.length === 0 ? (
              <div className="market-empty"><Cube size={30} /><strong>没有匹配的扩展</strong><span>可以修改关键词，或使用下方“本地导入”安装自定义包。</span></div>
            ) : (
              <div className="market-card-grid">
                {props.items.map((item) => {
                  const state = packageCardState(item, props.worlds)
                  const selectedClass = selected?.manifest.id === item.manifest.id ? ' is-selected' : ''
                  return (
                    <article key={`${item.manifest.id}-${item.manifest.version}`} className={`is-${state}${selectedClass}`}>
                      {item.market === 'theme' ? <img className="market-world-cover" src={marketplacePreviewUrl(item)} alt={`${item.manifest.displayName}世界预览`} /> : null}
                      {item.market === 'talent' ? <img className="market-role-cover" src={marketplacePreviewUrl(item)} alt={`${item.manifest.displayName}角色风格预览`} /> : null}
                      <header><MarketIcon market={item.market} /><div><strong>{item.manifest.displayName}</strong><span>{item.manifest.publisher} · v{item.manifest.version}</span></div>{item.verified ? <em><ShieldCheck size={14} />官方校验</em> : <em className="is-community">社区包</em>}</header>
                      <p>{item.manifest.summary}</p>
                      {item.market === 'theme' ? <div className="market-world-facts"><span>完整场景皮肤</span><span>专属角色外观</span><span>独立会话与档案</span></div> : null}
                      {item.market === 'talent' ? <div className="market-role-world">适合：{roleWorldLabel(item.activation?.kind === 'employee-blueprint' ? item.activation.worldTemplateId : undefined)}</div> : null}
                      {item.market === 'plugin' ? <div className="market-plugin-scope">按世界启用 · 设置与会话相互隔离</div> : null}
                      <div className="market-capabilities">{item.manifest.capabilities.slice(0, 4).map((capability) => <code key={capability}>{capabilityLabel(capability)}</code>)}</div>
                      <footer>
                        <span>{packageStateLabel(item, state)}</span>
                        {marketAction(item, state, () => prepareWorld(item), () => void inspect(item), () => activate(item))}
                      </footer>
                    </article>
                  )
                })}
              </div>
            )}
            <button className="manual-install-toggle" type="button" onClick={() => setManualOpen((value) => !value)}><FolderOpen size={16} />{manualOpen ? '收起本地导入' : '本地导入自定义包'}</button>
            {manualOpen ? <ManualInstaller installing={props.installing} onPreview={props.onPreview} onInstall={props.onInstall} /> : null}
          </main>
          <aside className="market-review-panel">
            {creatingWorldFor !== undefined
              ? <WorldCreationReview item={creatingWorldFor} name={worldName} creating={creatingWorld} onName={setWorldName} onCreate={() => void createWorld()} />
              : selectedCurrent !== undefined && preview !== undefined
                ? <PermissionReview manifest={selectedCurrent.manifest} preview={preview} approved={approved} installing={props.installing} onApproved={setApproved} onInstall={() => void install()} />
                : selectedInstalled?.market === 'talent'
                  ? <TalentActivationReview item={selectedInstalled} world={props.world} installedPackage={selectedInstalledPackage} installing={props.installing} confirmingUninstall={confirmingUninstall} onConfirmUninstall={setConfirmingUninstall} onUninstall={props.onUninstall} onRecruit={() => props.onRecruitTalent(selectedInstalled)} />
                  : selectedInstalled?.market === 'plugin'
                    ? <PluginActivationReview item={selectedInstalled} installedPackage={selectedInstalledPackage} installing={props.installing} confirmingUninstall={confirmingUninstall} onConfirmUninstall={setConfirmingUninstall} onUninstall={props.onUninstall} onOpenSettings={props.onOpenSettings} onUse={props.onUsePlugin} />
                    : <InstalledOverview installed={props.installed} transactions={props.transactions} installing={props.installing} confirmingUninstall={confirmingUninstall} onConfirmUninstall={setConfirmingUninstall} onUninstall={props.onUninstall} />}
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
  return market === 'theme' ? <Buildings size={18} /> : market === 'talent' ? <Storefront size={18} /> : market === 'skin' ? <Palette size={18} /> : <Cube size={18} />
}

function InstalledOverview({ installed, transactions, installing, confirmingUninstall, onConfirmUninstall, onUninstall }: { installed: InstalledPackage[]; transactions: PackageInstallTransaction[]; installing: boolean; confirmingUninstall?: string | undefined; onConfirmUninstall(packageId?: string): void; onUninstall(item: InstalledPackage): Promise<void> }) {
  const active = installed.filter((item) => item.status === 'active')
  return <div className="installed-overview"><h3>运行中的扩展</h3><p>{active.length} 个活动版本。卸载会同步停用各世界实例，安装文件保留在本机包库中。</p><div className="installed-package-list">{active.length === 0 ? <span className="dialog-empty">尚未安装扩展</span> : active.slice(0, 12).map((item) => <article key={`${item.packageId}-${item.version}`}><span className="package-kind">{packageKindLabel(item.kind)}</span><span className="installed-package-copy"><strong>{item.manifest.displayName}</strong><small>v{item.version}</small></span><PackageRemovalAction item={item} installing={installing} confirming={confirmingUninstall === item.packageId} onConfirm={() => onConfirmUninstall(item.packageId)} onCancel={() => onConfirmUninstall(undefined)} onUninstall={onUninstall} /></article>)}</div><div className="package-history"><strong>最近安装</strong>{transactions.length === 0 ? <span>暂无记录</span> : transactions.slice(0, 6).map((item) => <span key={item.id} className={`transaction-status transaction-status--${item.status}`}>{installed.find((installedItem) => installedItem.packageId === item.packageId)?.manifest.displayName ?? item.packageId} · {transactionLabel(item.status)}</span>)}</div></div>
}

function PackageRemovalAction({ item, installing, confirming, onConfirm, onCancel, onUninstall }: { item: InstalledPackage; installing: boolean; confirming: boolean; onConfirm(): void; onCancel(): void; onUninstall(item: InstalledPackage): Promise<void> }) {
  if (confirming) return <span className="package-removal-confirm"><button className="text-button" type="button" disabled={installing} onClick={onCancel}>取消</button><button className="danger-button" type="button" disabled={installing} onClick={() => void onUninstall(item).finally(onCancel)}>{installing ? '处理中…' : '确认卸载'}</button></span>
  return <button className="text-button package-remove-button" type="button" disabled={installing} onClick={onConfirm}><Trash size={14} />卸载</button>
}

function PermissionReview({ manifest, preview, approved, installing, onApproved, onInstall }: { manifest: CyberPackageManifest; preview: PackagePermissionPreview; approved: boolean; installing: boolean; onApproved(value: boolean): void; onInstall(): void }) {
  return <section className="permission-review permission-review--market"><header><div><span>{packageKindLabel(manifest.kind)}</span><h4>{manifest.displayName} <small>v{manifest.version}</small></h4><p>{manifest.publisher} · {manifest.license}</p></div><CheckCircle size={24} /></header><p>{manifest.summary}</p><PermissionGroup title="新增能力" values={preview.addedCapabilities.map(capabilityLabel)} empty="没有新增能力" tone="warning" /><PermissionGroup title="数据外发" values={preview.dataEgress} empty={manifest.kind === 'skill' ? '发布者声明不外发数据（Skill 的外发声明由发布者负责，运行时不强制）' : '不外发数据'} tone={preview.dataEgress.length > 0 ? 'danger' : manifest.kind === 'skill' ? 'warning' : 'safe'} /><div className="package-file-summary">激活前将再次校验 {manifest.files.length} 个文件与入口定义；失败不会覆盖当前版本。</div><label className="approval-check"><input type="checkbox" checked={approved} onChange={(event) => onApproved(event.target.checked)} /><span>我已审阅发布者、许可证、文件与运行能力。</span></label><button className="primary-button" type="button" disabled={!approved || installing} onClick={onInstall}>{installing ? '正在安装并激活…' : preview.previousVersion ? `批准升级至 v${preview.version}` : `批准安装 v${preview.version}`}</button></section>
}

function WorldCreationReview({ item, name, creating, onName, onCreate }: { item: CyberMarketPackage; name: string; creating: boolean; onName(value: string): void; onCreate(): void }) {
  return <section className="world-creation-review">
    <img src={marketplacePreviewUrl(item)} alt={`${item.manifest.displayName}世界预览`} />
    <div><span>已安装的世界皮肤</span><h3>{item.manifest.displayName}</h3><p>{item.manifest.summary}</p></div>
    <ul><li>创建独立世界，不覆盖当前世界</li><li>自动加入三名对应设定的起始角色</li><li>会话、档案、任务和运行状态彼此隔离</li></ul>
    <label className="dialog-field"><span>新世界名称</span><input value={name} maxLength={60} autoFocus onChange={(event) => onName(event.target.value)} placeholder="为这个世界命名" /></label>
    <button className="primary-button" type="button" disabled={creating || name.trim().length === 0} onClick={onCreate}>{creating ? '正在布置世界…' : '创建并进入这个世界'}</button>
  </section>
}

function TalentActivationReview({ item, world, installedPackage, installing, confirmingUninstall, onConfirmUninstall, onUninstall, onRecruit }: { item: CyberMarketPackage; world: World; installedPackage?: InstalledPackage | undefined; installing: boolean; confirmingUninstall?: string | undefined; onConfirmUninstall(packageId?: string): void; onUninstall(item: InstalledPackage): Promise<void>; onRecruit(): Promise<void> }) {
  const activation = item.activation?.kind === 'employee-blueprint' ? item.activation : undefined
  const compatible = activation !== undefined && (world.templateId === 'personal-world' || activation.worldTemplateId === world.templateId)
  return <section className="market-activation-review">
    <img src={marketplacePreviewUrl(item)} alt={`${item.manifest.displayName}角色风格预览`} />
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
  if (item.installedVersion === item.manifest.version) {
    if (hasCreatedWorld) return 'created'
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
    const next = item.market === 'theme' ? '可创建' : item.market === 'talent' ? '可招募' : '可使用'
    return `已安装 v${item.installedVersion} · ${next}`
  }
  if (state === 'upgrade') return `已安装 v${item.installedVersion} · 有新版 v${item.manifest.version}`
  if (state === 'available') return `包库已有 v${item.installedVersion} · 当前世界未启用`
  if (state === 'included') return '已内置 · 当前可用'
  return '未安装'
}

function marketAction(item: CyberMarketPackage, state: PackageCardState, onBind: () => void, onInspect: () => void, onActivate: () => void) {
  if (item.market === 'theme' && state === 'created') return <button className="market-action--created" type="button" disabled><CheckCircle size={15} />已创建</button>
  if (item.market === 'theme' && state === 'installed') return <button className="market-action--installed" type="button" onClick={onBind}>创建新世界</button>
  if (state === 'installed') return <button className="market-action--installed" type="button" onClick={onActivate}>{item.market === 'talent' ? '招募到世界' : '立即使用'}</button>
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

function marketplacePreviewUrl(item: CyberMarketPackage): string {
  return `/api/marketplace/packages/${encodeURIComponent(item.manifest.id)}/${encodeURIComponent(item.manifest.version)}/preview`
}

function roleWorldLabel(templateId: string | undefined): string {
  return ({
    'tavern': '月影酒馆',
    'creator-studio': '云端创作工坊',
    'orbital-observatory': '远星观测站',
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
    skin: '界面皮肤',
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
