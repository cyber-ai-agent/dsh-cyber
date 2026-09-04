import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowsClockwise, CheckCircle, Lightning, MagnifyingGlass, PencilSimple, Plus, Stack, Trash, WarningCircle, X } from '@phosphor-icons/react'

import './model-hub.css'
import { useI18n } from '../../i18n/runtime.js'
import { ApiError } from '../../api.js'
import {
  deleteProvider,
  fetchBalance,
  importModels,
  listProfiles,
  listProviders,
  loadCatalog,
  refreshCatalog,
  removeProfile,
  saveProvider,
  syncProvider,
  testProvider,
  type DiscoveredModel,
  type HubCatalogEntry,
  type HubCatalogState,
  type HubProfile,
  type HubProvider,
  type SyncOutcome,
} from './api.js'
import {
  allSelected,
  declaredCapabilities,
  defaultSelection,
  filterPool,
  formatContext,
  IMPORT_CAP,
  mergeSelection,
  poolFilters,
  searchModels,
  selectionModels,
  summarizeSync,
  toggleSelection,
  unmergeSelection,
  type PoolFilterKey,
} from './view-model.js'

interface FormState {
  providerRef: string
  name: string
  api: string
  providerKind: string
  baseUrl: string
  apiKey: string
  credentialEnvName: string
}

type WizardStep = 'form' | 'models'

interface WizardState {
  step: WizardStep
  /** Set once the connection row exists (saved at the test step). */
  providerId?: string
  editing?: HubProvider
  form: FormState
  models: DiscoveredModel[]
  selected: Set<string>
}

const CUSTOM_REF = 'custom'
const LOCAL_REF = 'local'

const EMPTY_FORM: FormState = {
  providerRef: CUSTOM_REF,
  name: '',
  api: 'openai-completions',
  providerKind: 'openai-compatible-remote',
  baseUrl: '',
  apiKey: '',
  credentialEnvName: '',
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError && cause.message) return cause.message
  return cause instanceof Error && cause.message ? cause.message : fallback
}

export function ModelHubDialog({ workspaceId, onClose }: { workspaceId: string; onClose(): void }) {
  const { t } = useI18n()
  const [tab, setTab] = useState<'providers' | 'pool'>('providers')
  const [catalog, setCatalog] = useState<HubCatalogState>()
  const [providers, setProviders] = useState<HubProvider[]>([])
  const [profiles, setProfiles] = useState<HubProfile[]>([])
  const [assignedProfileIds, setAssignedProfileIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [balances, setBalances] = useState<Record<string, { lines: string[]; asOf: string } | 'loading' | string>>({})
  const [syncs, setSyncs] = useState<Record<string, SyncOutcome>>({})
  const [confirmingDelete, setConfirmingDelete] = useState<string>()
  const [confirmingRemove, setConfirmingRemove] = useState<string>()
  const [poolQuery, setPoolQuery] = useState('')
  const [poolFilter, setPoolFilter] = useState<PoolFilterKey>('all')
  const [wizard, setWizard] = useState<WizardState>()
  const [modelQuery, setModelQuery] = useState('')
  const panelRef = useRef<HTMLElement>(null)

  const reload = useCallback(async () => {
    const [nextCatalog, nextProviders, nextProfiles] = await Promise.all([loadCatalog(), listProviders(workspaceId), listProfiles(workspaceId)])
    setCatalog(nextCatalog)
    setProviders(nextProviders)
    setProfiles(nextProfiles.profiles)
    setAssignedProfileIds(new Set(nextProfiles.assignments.map((assignment) => assignment.modelProfileId)))
  }, [workspaceId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try { await reload() } catch (cause) {
        if (!cancelled) setError(errorMessage(cause, t('modelHub.loadFailed', '模型中心数据加载失败。')))
      }
    })()
    return () => { cancelled = true }
  }, [reload, t])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && wizard === undefined) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, wizard])

  const entryForRef = (ref: string): HubCatalogEntry | undefined =>
    catalog?.catalog.providers.find((candidate) => candidate.id === ref)

  const formForRef = (ref: string, editing?: HubProvider): FormState => {
    if (editing !== undefined) {
      return { ...EMPTY_FORM, providerRef: ref, name: editing.name, api: editing.api, providerKind: editing.providerKind, baseUrl: editing.baseUrl }
    }
    const entry = entryForRef(ref)
    if (entry !== undefined) return { ...EMPTY_FORM, providerRef: ref, name: entry.name, api: entry.api, providerKind: entry.providerKind, baseUrl: entry.baseUrl }
    if (ref === LOCAL_REF) return { ...EMPTY_FORM, providerRef: ref, name: t('modelHub.sourceLocal', '本机 / 局域网推理服务'), baseUrl: 'http://127.0.0.1:8000/v1' }
    return { ...EMPTY_FORM, providerRef: ref, name: t('modelHub.sourceCustom', '自定义 HTTPS 服务') }
  }

  const runWizardTest = async (state: WizardState): Promise<void> => {
    setBusy('test')
    setError(undefined)
    const entry = entryForRef(state.form.providerRef)
    try {
      const saved = await saveProvider(workspaceId, {
        ...(state.editing === undefined ? {} : { id: state.editing.id }),
        name: state.form.name,
        baseUrl: state.form.baseUrl,
        api: state.form.api,
        providerKind: state.form.providerKind,
        ...(entry === undefined ? {} : { catalogRef: entry.id }),
        ...(state.form.credentialEnvName.trim() !== ''
          ? { credentialEnvName: state.form.credentialEnvName.trim() }
          : state.form.apiKey.trim() !== ''
          ? { apiKey: state.form.apiKey.trim() }
          : state.editing !== undefined
          ? {}
          : { credentialEnvName: null }),
      })
      const models = await testProvider(workspaceId, saved.id)
      // From here the connection row exists: editing the form and re-testing
      // must upsert this row, never mint a duplicate provider.
      setWizard({ ...state, step: 'models', providerId: saved.id, editing: state.editing ?? saved, models, selected: defaultSelection(models, entry?.popularModels ?? []) })
      await reload()
    } catch (cause) {
      setError(errorMessage(cause, t('modelHub.testFailed', '测试连接失败，请检查地址与密钥。')))
    } finally {
      setBusy(undefined)
    }
  }

  const openWizard = (editing?: HubProvider): void => {
    setModelQuery('')
    const ref = editing === undefined
      ? CUSTOM_REF
      : editing.catalogRef ?? (editing.providerKind === 'openai-compatible-local' ? LOCAL_REF : CUSTOM_REF)
    setWizard({ step: 'form', ...(editing === undefined ? {} : { editing }), form: formForRef(ref, editing), models: [], selected: new Set<string>() })
  }

  const confirmImport = async (state: WizardState): Promise<void> => {
    const chosen = selectionModels(state.models, state.selected).slice(0, IMPORT_CAP)
    if (chosen.length === 0) {
      setWizard(undefined)
      return
    }
    if (state.providerId === undefined) {
      setError(t('modelHub.importFailed', '模型导入失败。'))
      return
    }
    setBusy('import')
    try {
      await importModels(workspaceId, state.providerId, chosen)
      setWizard(undefined)
      await reload()
    } catch (cause) {
      setError(errorMessage(cause, t('modelHub.importFailed', '模型导入失败。')))
    } finally {
      setBusy(undefined)
    }
  }

  const removeProvider = async (provider: HubProvider): Promise<void> => {
    setBusy(`delete:${provider.id}`)
    setError(undefined)
    try {
      await deleteProvider(workspaceId, provider.id)
      setConfirmingDelete(undefined)
      await reload()
    } catch (cause) {
      setError(errorMessage(cause, t('modelHub.deleteFailed', '删除服务商失败。')))
    } finally {
      setBusy(undefined)
    }
  }

  const runRemoveProfile = async (profile: HubProfile): Promise<void> => {
    setBusy(`remove:${profile.id}`)
    setError(undefined)
    try {
      await removeProfile(workspaceId, profile.id)
      setConfirmingRemove(undefined)
      await reload()
    } catch (cause) {
      setError(errorMessage(cause, t('modelHub.removeFailed', '从模型池移除失败。')))
    } finally {
      setBusy(undefined)
    }
  }

  const runSync = async (provider: HubProvider): Promise<void> => {
    setBusy(`sync:${provider.id}`)
    setError(undefined)
    try {
      const outcome = await syncProvider(workspaceId, provider.id)
      setSyncs((current) => ({ ...current, [provider.id]: outcome }))
    } catch (cause) {
      setError(errorMessage(cause, t('modelHub.syncFailed', '模型同步失败。')))
    } finally {
      setBusy(undefined)
    }
  }

  const runBalance = async (provider: HubProvider): Promise<void> => {
    setBalances((current) => ({ ...current, [provider.id]: 'loading' }))
    try {
      const result = await fetchBalance(workspaceId, provider.id)
      setBalances((current) => ({ ...current, [provider.id]: result }))
    } catch (cause) {
      setBalances((current) => ({ ...current, [provider.id]: errorMessage(cause, t('modelHub.balanceFailed', '余额查询失败。')) }))
    }
  }

  const filterOptions = useMemo(() => poolFilters(providers, profiles), [providers, profiles])
  const poolRows = useMemo(() => filterPool(profiles, providers, poolFilter, poolQuery), [profiles, providers, poolFilter, poolQuery])
  const providerNameOf = (profile: HubProfile): string =>
    providers.find((provider) => provider.id === profile.providerId)?.name ?? t('modelHub.legacyConnection', '独立配置')
  const filterLabel = (key: PoolFilterKey): string => {
    if (key === 'all') return t('modelHub.poolAll', '全部')
    if (key === 'legacy') return t('modelHub.legacyConnection', '独立配置')
    return providers.find((provider) => provider.id === key)?.name ?? key
  }

  const sourceBadge = catalog === undefined ? '' : catalog.source === 'remote'
    ? t('modelHub.sourceRemote', '目录来源：远程最新')
    : catalog.source === 'cache'
    ? t('modelHub.sourceCache', '目录来源：本地缓存')
    : t('modelHub.sourceBundled', '目录来源：随应用打包')

  const modalityLabel = (type: string): string =>
    type === 'text' ? t('modelHub.modalityText', '文本') : type === 'image' ? t('modelHub.modalityImage', '图片') : type === 'video' ? t('modelHub.modalityVideo', '视频') : t('modelHub.modalityAudio', '音频')

  // Portal to <body>: the launcher renders from the top bar, where global
  // rules like `.topbar nav { height: 100% }` would claim the hub's own tab
  // strip, and a modal belongs outside the banner landmark anyway.
  return createPortal(<div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && wizard === undefined) onClose() }}>
    <section ref={panelRef} className="model-hub" role="dialog" aria-modal="true" aria-labelledby="model-hub-title">
      <header className="model-hub__header">
        <div>
          <h2 id="model-hub-title"><Stack size={18} /> {t('modelHub.title', 'AI 模型管理中心')}</h2>
          <p>{sourceBadge}{catalog === undefined ? '' : ` · ${t('modelHub.catalogVersion', '目录版本 {version}', { version: catalog.catalog.version })}`}{catalog?.notice === undefined ? '' : ` · ${catalog.notice}`}</p>
        </div>
        <div className="model-hub__header-actions">
          <button type="button" className="icon-button" aria-label={t('modelHub.refresh', '刷新服务商目录')} disabled={busy === 'catalog-refresh'} onClick={async () => {
            setBusy('catalog-refresh')
            try { setCatalog(await refreshCatalog()) } catch (cause) { setError(errorMessage(cause, t('modelHub.refreshFailed', '目录刷新失败。'))) } finally { setBusy(undefined) }
          }}><ArrowsClockwise size={16} className={busy === 'catalog-refresh' ? 'spin' : undefined} /></button>
          <button type="button" className="icon-button" aria-label={t('modelHub.close', '关闭模型中心')} data-dialog-initial-focus onClick={onClose}><X size={18} /></button>
        </div>
      </header>

      <nav className="model-hub__tabs" aria-label={t('modelHub.tabsAria', '模型中心分区')}>
        <button type="button" aria-current={tab === 'providers'} className={tab === 'providers' ? 'is-active' : ''} onClick={() => setTab('providers')}>{t('modelHub.tabProviders', '模型服务商')}</button>
        <button type="button" aria-current={tab === 'pool'} className={tab === 'pool' ? 'is-active' : ''} onClick={() => setTab('pool')}>{t('modelHub.tabPool', '模型池')}</button>
      </nav>

      {error !== undefined ? <div className="model-hub__error" role="alert"><WarningCircle size={15} /><span>{error}</span><button type="button" className="icon-button" aria-label={t('modelHub.dismissError', '收起提示')} onClick={() => setError(undefined)}><X size={13} /></button></div> : null}

      {wizard === undefined && tab === 'providers' ? <div className="model-hub__body">
        <div className="model-hub__toolbar">
          <button type="button" className="primary-button" onClick={() => openWizard()}><Plus size={15} />{t('modelHub.addProvider', '添加服务商')}</button>
          <span className="model-hub__hint">{t('modelHub.providersHint', '一个服务商 = 一个端点、一份密钥；模型从服务商导入后分配给角色。')}</span>
        </div>
        {providers.length === 0 ? <div className="model-hub__empty"><strong>{t('modelHub.emptyProviders', '还没有添加服务商')}</strong><span>{t('modelHub.emptyProvidersHint', '点击“添加服务商”，选择一家填上密钥即可。')}</span></div> : providers.map((provider) => {
          const balance = balances[provider.id]
          const sync = syncs[provider.id]
          return <article key={provider.id} className="model-hub__provider-card">
            <header>
              <strong>{provider.name}</strong>
              <span className="model-hub__badges">
                <span className="model-hub__badge">{provider.kind === 'builtin' ? t('modelHub.kindBuiltin', '内置') : provider.kind === 'local' ? t('modelHub.kindLocal', '本地/局域网') : t('modelHub.kindCustom', '自定义')}</span>
                <span className={provider.credentialConfigured ? 'model-hub__badge is-ok' : 'model-hub__badge is-warn'}>{provider.credentialConfigured ? (provider.credentialTail === undefined ? t('modelHub.keyConfigured', '密钥已配置') : `密钥 ····${provider.credentialTail}`) : t('modelHub.keyMissing', '未配置密钥')}</span>
                <span className="model-hub__badge">{t('modelHub.modelCount', '{count} 个模型', { count: provider.modelCount })}</span>
              </span>
            </header>
            <code title={provider.baseUrl}>{provider.baseUrl}</code>
            {provider.signup !== undefined ? <p className="model-hub__signup">{provider.signup.text} <a href={provider.signup.url} target="_blank" rel="noopener noreferrer">{t('modelHub.openSignup', '打开注册页 ↗')}</a></p> : null}
            <footer>
              <button type="button" onClick={() => openWizard(provider)}><PencilSimple size={14} />{t('modelHub.edit', '编辑')}</button>
              <button type="button" disabled={busy === `sync:${provider.id}`} onClick={() => void runSync(provider)}><ArrowsClockwise size={14} className={busy === `sync:${provider.id}` ? 'spin' : undefined} />{t('modelHub.sync', '同步模型')}</button>
              {provider.balanceSupported ? <button type="button" onClick={() => void runBalance(provider)}><Lightning size={14} />{t('modelHub.balance', '查余额')}</button> : null}
              {confirmingDelete === provider.id
                ? <span className="model-hub__confirm"><button type="button" className="is-danger" onClick={() => void removeProvider(provider)}>{t('modelHub.confirmDelete', '确认删除')}</button><button type="button" onClick={() => setConfirmingDelete(undefined)}>{t('modelHub.cancel', '取消')}</button></span>
                : <button type="button" aria-label={t('modelHub.deleteAria', '删除服务商 {name}', { name: provider.name })} onClick={() => setConfirmingDelete(provider.id)}><Trash size={14} />{t('modelHub.delete', '删除')}</button>}
            </footer>
            {typeof balance === 'object' ? <p className="model-hub__balance">{balance.lines.join(' · ')}<small>{t('modelHub.balanceAsOf', '截至 {time}', { time: new Date(balance.asOf).toLocaleString() })}</small></p> : null}
            {balance === 'loading' ? <p className="model-hub__balance">{t('modelHub.balanceLoading', '正在查询余额…')}</p> : null}
            {typeof balance === 'string' && balance !== 'loading' ? <p className="model-hub__balance is-error">{balance}</p> : null}
            {sync !== undefined ? <p className="model-hub__sync">{(() => {
              const summary = summarizeSync(sync)
              return summary.added + summary.removed + summary.changed === 0
                ? t('modelHub.syncClean', '模型列表与服务端一致。')
                : t('modelHub.syncResult', '新增 {added} · 消失 {removed} · 上下文变化 {changed}', { added: summary.added, removed: summary.removed, changed: summary.changed })
            })()}
              {sync.added.length > 0 ? <button type="button" onClick={async () => { await importModels(workspaceId, provider.id, sync.added.slice(0, IMPORT_CAP)); setSyncs((current) => { const next = { ...current }; delete next[provider.id]; return next }); await reload() }}>{t('modelHub.importAdded', '导入新增')}</button> : null}
              {sync.changed.length > 0 ? <button type="button" onClick={async () => { await importModels(workspaceId, provider.id, sync.changed.map((item) => ({ id: item.modelId, contextLength: item.to }))); setSyncs((current) => { const next = { ...current }; delete next[provider.id]; return next }); await reload() }}>{t('modelHub.applyChanged', '应用上下文变化')}</button> : null}
            </p> : null}
          </article>
        })}
      </div> : null}

      {wizard === undefined && tab === 'pool' ? <div className="model-hub__pool">
        <aside className="model-hub__pool-filters" aria-label={t('modelHub.filterAria', '按服务商筛选模型')}>
          {filterOptions.map((option) => <button key={option.key} type="button" className={poolFilter === option.key ? 'is-active' : ''} aria-current={poolFilter === option.key} onClick={() => setPoolFilter(option.key)}>
            <span>{filterLabel(option.key)}</span><small>{option.count}</small>
          </button>)}
        </aside>
        <div className="model-hub__pool-main">
          <label className="model-hub__search"><MagnifyingGlass size={15} /><input value={poolQuery} onChange={(event) => setPoolQuery(event.target.value)} placeholder={t('modelHub.searchPool', '搜索模型名称或粘贴模型 ID')} aria-label={t('modelHub.searchPoolAria', '搜索模型池')} /></label>
          {poolRows.length === 0 ? <div className="model-hub__empty"><strong>{t('modelHub.poolEmpty', '这里还没有模型')}</strong><span>{t('modelHub.poolEmptyHint', '到“模型服务商”里测试连接并勾选导入模型。')}</span></div> : <table className="model-hub__table">
            <thead><tr>
              <th>{t('modelHub.colModel', '模型名称')}</th>
              <th>{t('modelHub.colModelId', '模型 ID')}</th>
              <th>{t('modelHub.colProvider', '服务商')}</th>
              <th>{t('modelHub.colContext', '上下文')}</th>
              <th>{t('modelHub.colInput', '输入格式')}</th>
              <th>{t('modelHub.colReasoning', '推理')}</th>
              <th className="model-hub__col-actions" aria-label={t('modelHub.colActions', '操作')} />
            </tr></thead>
            <tbody>{poolRows.map((profile) => {
              const declared = declaredCapabilities(profile)
              const assigned = assignedProfileIds.has(profile.id)
              const removing = busy === `remove:${profile.id}`
              return <tr key={profile.id}>
                <td><strong>{profile.displayName}</strong>{profile.isDefault ? <span className="model-hub__badge is-ok">{t('modelHub.defaultModel', '默认')}</span> : null}</td>
                <td><code>{profile.modelId}</code></td>
                <td>{providerNameOf(profile)}</td>
                <td>{formatContext(declared.context)}</td>
                <td>{declared.inputTypes.length === 0 ? '—' : declared.inputTypes.map((type) => <span key={type} className="model-hub__badge">{modalityLabel(type)}</span>)}</td>
                <td>{declared.reasoning === undefined ? '—' : declared.reasoning ? <span className="model-hub__cap is-good">{t('modelHub.reasonYes', '支持')}</span> : <span className="model-hub__cap">{t('modelHub.reasonNo', '不支持')}</span>}</td>
                <td className="model-hub__col-actions">{confirmingRemove === profile.id
                  ? <span className="model-hub__confirm"><button type="button" className="is-danger" onClick={() => void runRemoveProfile(profile)}>{t('modelHub.confirmRemove', '确认移除')}</button><button type="button" onClick={() => setConfirmingRemove(undefined)}>{t('modelHub.cancel', '取消')}</button></span>
                  : <button type="button" disabled={assigned || removing} title={assigned ? t('modelHub.removeBlocked', '正在被分配使用，请先在角色或世界中改选其它模型') : t('modelHub.removeFromPool', '从模型池移除')} aria-label={t('modelHub.removeFromAria', '移除模型 {name}', { name: profile.displayName })} onClick={() => setConfirmingRemove(profile.id)}><Trash size={14} /></button>}
                </td>
              </tr>
            })}</tbody>
          </table>}
        </div>
      </div> : null}

      {wizard !== undefined ? <div className="model-hub__wizard" role="region" aria-label={t('modelHub.wizardAria', '添加或编辑服务商')}>
        <header>
          {wizard.step === 'models' ? <button type="button" className="icon-button" aria-label={t('modelHub.wizardBack', '上一步')} onClick={() => setWizard({ ...wizard, step: 'form' })}><ArrowLeft size={15} /></button> : null}
          <strong>{wizard.step === 'form' ? (wizard.editing === undefined ? t('modelHub.formTitle', '填写连接信息') : t('modelHub.editTitle', '编辑服务商')) : t('modelHub.modelsTitle', '选择要导入的模型')}</strong>
          <button type="button" className="icon-button" aria-label={wizard.step === 'models' ? t('modelHub.wizardDone', '完成（服务商已保存，可稍后同步模型）') : t('modelHub.wizardCancel', '取消并返回')} onClick={() => { setWizard(undefined); void reload() }}>{wizard.step === 'models' ? <CheckCircle size={16} /> : <X size={16} />}</button>
        </header>
        {wizard.step === 'form' ? (() => {
          const selectedEntry = entryForRef(wizard.form.providerRef)
          const setForm = (patch: Partial<FormState>) => setWizard({ ...wizard, form: { ...wizard.form, ...patch } })
          const switchRef = (ref: string) => setWizard({ ...wizard, form: { ...formForRef(ref), apiKey: wizard.form.apiKey, credentialEnvName: wizard.form.credentialEnvName } })
          return <div className="model-hub__form">
            <label><span>{t('modelHub.fieldProvider', '选择服务商')}</span><select value={wizard.form.providerRef} onChange={(event) => switchRef(event.target.value)}>
              <option value={CUSTOM_REF}>{t('modelHub.sourceCustom', '自定义 HTTPS 服务')}</option>
              <option value={LOCAL_REF}>{t('modelHub.sourceLocal', '本机 / 局域网推理服务')}</option>
              {(catalog?.catalog.providers ?? []).map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.badge === undefined ? '' : `（${entry.badge}）`}</option>)}
            </select></label>
            <label><span>{t('modelHub.fieldName', '名称')}</span><input value={wizard.form.name} onChange={(event) => setForm({ name: event.target.value })} maxLength={80} /></label>
            <label><span>{t('modelHub.fieldApi', '接口协议')}</span><select value={wizard.form.api} onChange={(event) => setForm({ api: event.target.value })}><option value="openai-completions">OpenAI 对话补全</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic 消息协议</option></select></label>
            <label><span>{t('modelHub.fieldBaseUrl', '接口地址 Base URL')}</span><input value={wizard.form.baseUrl} onChange={(event) => setForm({ baseUrl: event.target.value })} placeholder={selectedEntry !== undefined ? selectedEntry.baseUrl : wizard.form.providerKind === 'openai-compatible-local' ? 'http://192.168.x.x:8000/v1' : 'https://api.example.com/v1'} /></label>
            <label><span>{t('modelHub.fieldKey', 'API 密钥')}</span><input type="password" value={wizard.form.apiKey} onChange={(event) => setForm({ apiKey: event.target.value })} placeholder={wizard.editing !== undefined ? t('modelHub.keyPlaceholderKeep', '留空则保持不变') : wizard.form.providerKind === 'openai-compatible-local' ? t('modelHub.keyHintLocal', '本地服务通常可留空') : t('modelHub.keyPlaceholderUnset', '尚未配置')} autoComplete="new-password" />{wizard.editing?.credentialConfigured === true && wizard.form.apiKey === '' ? <small>{wizard.editing.credentialTail === undefined ? t('modelHub.keySaved', '本机已保存该服务商的密钥') : `${t('modelHub.keySaved', '本机已保存该服务商的密钥')} ····${wizard.editing.credentialTail}`}</small> : null}</label>
            <label><span>{t('modelHub.fieldEnvName', '凭据环境变量名（可选，与 API 密钥二选一）')}</span><input value={wizard.form.credentialEnvName} onChange={(event) => setForm({ credentialEnvName: event.target.value.toUpperCase() })} placeholder="MY_MODEL_API_KEY" /></label>
            {selectedEntry !== undefined ? <p className="model-hub__signup">{selectedEntry.signup.text} <a href={selectedEntry.signup.url} target="_blank" rel="noopener noreferrer">{t('modelHub.openSignup', '打开注册页 ↗')}</a></p> : <p className="model-hub__signup">{wizard.form.providerRef === LOCAL_REF ? t('modelHub.sourceLocalHint', 'vLLM、Ollama、LM Studio、Sub2API 等 HTTP 端点。') : t('modelHub.sourceCustomHint', '连接其他可信的 OpenAI 兼容网关。')}</p>}
            <footer>
              <button type="button" className="primary-button" disabled={busy === 'test' || !wizard.form.name.trim() || !wizard.form.baseUrl.trim()} onClick={() => void runWizardTest(wizard)}>{busy === 'test' ? t('modelHub.testing', '正在测试并获取模型…') : t('modelHub.testFetch', '测试服务商并获取模型列表')}</button>
            </footer>
          </div>
        })() : null}
        {wizard.step === 'models' ? (() => {
          const visible = searchModels(wizard.models, modelQuery)
          const visibleIds = visible.map((model) => model.id)
          const everyVisible = allSelected(visible, wizard.selected)
          return <div className="model-hub__models-step">
            <p>{t('modelHub.modelsFound', '获取到 {count} 个模型，勾选后导入模型池。', { count: wizard.models.length })}</p>
            <div className="model-hub__models-tools">
              <label className="model-hub__search"><MagnifyingGlass size={15} /><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={t('modelHub.searchModels', '搜索模型（不影响已勾选）')} aria-label={t('modelHub.searchModelsAria', '搜索模型列表')} /></label>
              <button type="button" disabled={visible.length === 0} onClick={() => setWizard({ ...wizard, selected: everyVisible ? unmergeSelection(wizard.selected, visibleIds) : mergeSelection(wizard.selected, visibleIds) })}>
                {everyVisible ? t('modelHub.clearVisible', '取消本页全选') : t('modelHub.selectAllVisible', '全选搜索结果')}
              </button>
            </div>
            <ul>{visible.map((model) => <li key={model.id}>
              <label><input type="checkbox" checked={wizard.selected.has(model.id)} onChange={() => setWizard({ ...wizard, selected: toggleSelection(wizard.selected, model.id) })} />
                <span><strong>{model.displayName ?? model.id}</strong><code>{model.id}</code>
                  {model.contextLength === undefined ? null : <small>{t('modelHub.contextBadge', '上下文 {tokens}', { tokens: model.contextLength.toLocaleString() })}</small>}
                  {model.inputTypes === undefined || model.inputTypes.length === 0 ? null : <small>{model.inputTypes.map(modalityLabel).join('/')}</small>}
                  {model.reasoning === undefined ? null : <small>{model.reasoning ? t('modelHub.reasonYes', '支持') : t('modelHub.reasonNo', '不支持')}·{t('modelHub.colReasoning', '推理')}</small>}
                </span>
              </label>
            </li>)}{visible.length === 0 ? <li><span className="model-hub__empty-inline">{t('modelHub.noModelMatches', '没有匹配的模型')}</span></li> : null}</ul>
            <footer>
              <span>{t('modelHub.selectedCount', '已选 {count} 个', { count: wizard.selected.size })}{wizard.selected.size > IMPORT_CAP ? t('modelHub.overImportCap', '（单次最多导入 {max} 个，将取前 {max} 个）', { max: IMPORT_CAP }) : ''}</span>
              <button type="button" className="primary-button" disabled={busy === 'import' || wizard.selected.size === 0} onClick={() => void confirmImport(wizard)}>{busy === 'import' ? t('modelHub.importing', '正在导入…') : t('modelHub.import', '保存并导入模型池')}</button>
            </footer>
          </div>
        })() : null}
      </div> : null}
    </section>
  </div>, document.body)
}
