import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsClockwise, CheckCircle, Lightning, MagnifyingGlass, PencilSimple, Plus, Stack, Trash, WarningCircle, X } from '@phosphor-icons/react'

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
  probeProfile,
  refreshCatalog,
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
  CAPABILITY_MESSAGE_KEYS,
  capabilityFallback,
  capabilityTone,
  contextOf,
  defaultSelection,
  formatContext,
  groupPool,
  IMPORT_CAP,
  selectionModels,
  summarizeSync,
  toggleSelection,
} from './view-model.js'

interface FormState {
  name: string
  api: string
  providerKind: string
  baseUrl: string
  apiKey: string
  useEnvironment: boolean
  credentialEnvName: string
}

type WizardStep = 'source' | 'form' | 'models'

interface WizardState {
  step: WizardStep
  entry?: HubCatalogEntry
  editing?: HubProvider
  /** Set once the connection row exists (saved at the test step). */
  providerId?: string
  form: FormState
  models: DiscoveredModel[]
  selected: Set<string>
}

const EMPTY_FORM: FormState = {
  name: '',
  api: 'openai-completions',
  providerKind: 'openai-compatible-remote',
  baseUrl: '',
  apiKey: '',
  useEnvironment: false,
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
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [balances, setBalances] = useState<Record<string, { lines: string[]; asOf: string } | 'loading' | string>>({})
  const [syncs, setSyncs] = useState<Record<string, SyncOutcome>>({})
  const [confirmingDelete, setConfirmingDelete] = useState<string>()
  const [poolQuery, setPoolQuery] = useState('')
  const [probing, setProbing] = useState<Record<string, string>>({})
  const [wizard, setWizard] = useState<WizardState>()
  const panelRef = useRef<HTMLElement>(null)

  const reload = useCallback(async () => {
    const [nextCatalog, nextProviders, nextProfiles] = await Promise.all([loadCatalog(), listProviders(workspaceId), listProfiles(workspaceId)])
    setCatalog(nextCatalog)
    setProviders(nextProviders)
    setProfiles(nextProfiles)
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

  const catalogEntryFor = (provider: HubProvider): HubCatalogEntry | undefined =>
    catalog?.catalog.providers.find((entry) => entry.id === provider.catalogRef)

  const runWizardTest = async (state: WizardState): Promise<void> => {
    setBusy('test')
    setError(undefined)
    try {
      const saved = await saveProvider(workspaceId, {
        ...(state.editing === undefined ? {} : { id: state.editing.id }),
        name: state.form.name,
        baseUrl: state.form.baseUrl,
        api: state.form.api,
        providerKind: state.form.providerKind,
        ...(state.entry === undefined ? {} : { catalogRef: state.entry.id }),
        ...(state.form.useEnvironment
          ? { credentialEnvName: state.form.credentialEnvName.trim() || null }
          : state.form.apiKey.trim() !== ''
          ? { apiKey: state.form.apiKey.trim() }
          : state.editing !== undefined
          ? {}
          : { credentialEnvName: null }),
      })
      const models = await testProvider(workspaceId, saved.id)
      setWizard({ ...state, step: 'models', providerId: saved.id, models, selected: defaultSelection(models, state.entry?.popularModels ?? []) })
      await reload()
    } catch (cause) {
      setError(errorMessage(cause, t('modelHub.testFailed', '测试连接失败，请检查地址与密钥。')))
    } finally {
      setBusy(undefined)
    }
  }

  const openForm = (entry?: HubCatalogEntry, kind?: 'custom' | 'local', editing?: HubProvider): void => {
    setWizard({
      step: 'form',
      ...(entry === undefined ? {} : { entry }),
      ...(editing === undefined ? {} : { editing }),
      form: editing !== undefined
        ? { ...EMPTY_FORM, name: editing.name, api: editing.api, providerKind: editing.providerKind, baseUrl: editing.baseUrl }
        : entry !== undefined
        ? { ...EMPTY_FORM, name: entry.name, api: entry.api, providerKind: entry.providerKind, baseUrl: entry.baseUrl, useEnvironment: entry.credentialMode === 'environment' }
        : { ...EMPTY_FORM, providerKind: kind === 'local' ? 'openai-compatible-local' : 'openai-compatible-remote', ...(kind === 'local' ? { baseUrl: 'http://127.0.0.1:8000/v1' } : {}) },
      models: [],
      selected: new Set<string>(),
    })
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

  const runProbe = async (profile: HubProfile): Promise<void> => {
    setProbing((current) => ({ ...current, [profile.id]: 'loading' }))
    setError(undefined)
    try {
      await probeProfile(workspaceId, profile.id)
      setProbing((current) => {
        const next = { ...current }
        delete next[profile.id]
        return next
      })
      await reload()
    } catch (cause) {
      setProbing((current) => ({ ...current, [profile.id]: errorMessage(cause, t('modelHub.probeFailed', '能力探测失败。')) }))
      await reload()
    }
  }

  const poolGroups = useMemo(() => groupPool(profiles, providers, poolQuery), [profiles, providers, poolQuery])
  const providerName = (profile: HubProfile): string =>
    providers.find((provider) => provider.id === profile.providerId)?.name ?? t('modelHub.legacyConnection', '独立配置')

  const sourceBadge = catalog === undefined ? '' : catalog.source === 'remote'
    ? t('modelHub.sourceRemote', '目录来源：远程最新')
    : catalog.source === 'cache'
    ? t('modelHub.sourceCache', '目录来源：本地缓存')
    : t('modelHub.sourceBundled', '目录来源：随应用打包')

  return <div className="model-hub-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && wizard === undefined) onClose() }}>
    <section ref={panelRef} className="model-hub" role="dialog" aria-modal="true" aria-labelledby="model-hub-title">
      <header className="dialog-header">
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

      <nav className="model-hub__tabs" role="tablist">
        <button role="tab" type="button" aria-selected={tab === 'providers'} className={tab === 'providers' ? 'is-active' : ''} onClick={() => setTab('providers')}>{t('modelHub.tabProviders', '模型服务商')}</button>
        <button role="tab" type="button" aria-selected={tab === 'pool'} className={tab === 'pool' ? 'is-active' : ''} onClick={() => setTab('pool')}>{t('modelHub.tabPool', '模型池')}</button>
      </nav>

      {error !== undefined ? <div className="model-hub__error" role="alert"><WarningCircle size={15} /><span>{error}</span><button type="button" className="icon-button" aria-label={t('modelHub.dismissError', '收起提示')} onClick={() => setError(undefined)}><X size={13} /></button></div> : null}

      {wizard === undefined && tab === 'providers' ? <div className="model-hub__body">
        <div className="model-hub__toolbar">
          <button type="button" className="primary-button" onClick={() => setWizard({ step: 'source', form: EMPTY_FORM, models: [], selected: new Set() })}><Plus size={15} />{t('modelHub.addProvider', '添加服务商')}</button>
          <span className="model-hub__hint">{t('modelHub.providersHint', '一个服务商 = 一个端点、一份密钥；模型从服务商导入后分配给角色。')}</span>
        </div>
        {providers.length === 0 ? <div className="model-hub__empty"><strong>{t('modelHub.emptyProviders', '还没有添加服务商')}</strong><span>{t('modelHub.emptyProvidersHint', '点击“添加服务商”，内置目录里选一家填上密钥即可。')}</span></div> : providers.map((provider) => {
          const balance = balances[provider.id]
          const sync = syncs[provider.id]
          return <article key={provider.id} className="model-hub__provider-card">
            <header>
              <strong>{provider.name}</strong>
              <span className="model-hub__badges">
                <span className="model-hub__badge">{provider.kind === 'builtin' ? t('modelHub.kindBuiltin', '内置') : provider.kind === 'local' ? t('modelHub.kindLocal', '本地/局域网') : t('modelHub.kindCustom', '自定义')}</span>
                <span className={provider.credentialConfigured ? 'model-hub__badge is-ok' : 'model-hub__badge is-warn'}>{provider.credentialConfigured ? t('modelHub.keyConfigured', '密钥已配置') : t('modelHub.keyMissing', '未配置密钥')}</span>
                <span className="model-hub__badge">{t('modelHub.modelCount', '{count} 个模型', { count: provider.modelCount })}</span>
              </span>
            </header>
            <code title={provider.baseUrl}>{provider.baseUrl}</code>
            {provider.signup !== undefined ? <p className="model-hub__signup">{provider.signup.text} <a href={provider.signup.url} target="_blank" rel="noopener noreferrer">{t('modelHub.openSignup', '打开注册页 ↗')}</a></p> : null}
            <footer>
              <button type="button" onClick={() => openForm(catalogEntryFor(provider), undefined, provider)}><PencilSimple size={14} />{t('modelHub.edit', '编辑')}</button>
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

      {wizard === undefined && tab === 'pool' ? <div className="model-hub__body">
        <label className="model-hub__search"><MagnifyingGlass size={15} /><input value={poolQuery} onChange={(event) => setPoolQuery(event.target.value)} placeholder={t('modelHub.searchPool', '搜索模型名称或粘贴模型 ID')} aria-label={t('modelHub.searchPoolAria', '搜索模型池')} /></label>
        {poolGroups.length === 0 ? <div className="model-hub__empty"><strong>{t('modelHub.poolEmpty', '模型池是空的')}</strong><span>{t('modelHub.poolEmptyHint', '先在“模型服务商”里添加服务商，测试连接后勾选模型导入。')}</span></div> : poolGroups.map((group) => <section key={group.provider?.id ?? 'unassigned'} className="model-hub__group">
          <h3>{group.provider?.name ?? t('modelHub.legacyConnection', '独立配置')}<small>{t('modelHub.groupCount', '{count} 个模型', { count: group.profiles.length })}</small></h3>
          {group.profiles.map((profile) => {
            const probeState = probing[profile.id]
            return <article key={profile.id} className="model-hub__model-card">
              <header>
                <strong>{profile.displayName}{profile.isDefault ? <span className="model-hub__badge is-ok">{t('modelHub.defaultModel', '默认')}</span> : null}</strong>
                <code>{profile.modelId}</code>
              </header>
              <p>
                {t('modelHub.contextLabel', '上下文 {value}', { value: formatContext(contextOf(profile)) })}
                {' · '}{(() => {
                  const tone = capabilityTone(profile.capabilities?.tools)
                  const verdict = profile.capabilities?.tools
                  const label = verdict === undefined ? capabilityFallback(undefined) : t(CAPABILITY_MESSAGE_KEYS[verdict as keyof typeof CAPABILITY_MESSAGE_KEYS] ?? 'modelHub.verdictUnclear', capabilityFallback(verdict))
                  return <span className={`model-hub__cap is-${tone}`} title={t('modelHub.capToolsTitle', '工具调用能力：{verdict}', { verdict: label })}><CheckCircle size={12} />{t('modelHub.capTools', '工具')}·{label}</span>
                })()}
                {' '}{(() => {
                  const tone = capabilityTone(profile.capabilities?.json)
                  const verdict = profile.capabilities?.json
                  const label = verdict === undefined ? capabilityFallback(undefined) : t(CAPABILITY_MESSAGE_KEYS[verdict as keyof typeof CAPABILITY_MESSAGE_KEYS] ?? 'modelHub.verdictUnclear', capabilityFallback(verdict))
                  return <span className={`model-hub__cap is-${tone}`} title={t('modelHub.capJsonTitle', '结构化 JSON 能力：{verdict}', { verdict: label })}><CheckCircle size={12} />JSON·{label}</span>
                })()}
              </p>
              <footer>
                <span className="model-hub__from">{t('modelHub.fromProvider', '来自 {name}', { name: providerName(profile) })}{profile.probedAt === undefined ? '' : ` · ${new Date(profile.probedAt).toLocaleString()}`}</span>
                {probeState === 'loading'
                  ? <span className="model-hub__balance">{t('modelHub.probing', '正在探测能力…')}</span>
                  : probeState !== undefined && probeState !== 'loading'
                  ? <span className="model-hub__balance is-error">{probeState}<button type="button" onClick={() => setProbing((current) => { const next = { ...current }; delete next[profile.id]; return next })}>{t('modelHub.dismiss', '收起')}</button></span>
                  : <button type="button" onClick={() => void runProbe(profile)}><Lightning size={14} />{t('modelHub.probe', '检测能力')}</button>}
              </footer>
            </article>
          })}</section>)}
      </div> : null}

      {wizard !== undefined ? <div className="model-hub__wizard" role="region" aria-label={t('modelHub.wizardAria', '添加或编辑服务商')}>
        <header>
          {wizard.step !== 'source' ? <button type="button" className="icon-button" aria-label={t('modelHub.wizardBack', '上一步')} onClick={() => setWizard(wizard.step === 'models' ? { ...wizard, step: 'form' } : { ...wizard, step: 'source' })}><ArrowsClockwise size={14} style={{ transform: 'scaleX(-1)' }} /></button> : null}
          <strong>{wizard.step === 'source' ? t('modelHub.sourceTitle', '选择服务商来源') : wizard.step === 'form' ? t('modelHub.formTitle', '填写连接信息') : t('modelHub.modelsTitle', '选择要导入的模型')}</strong>
          <button type="button" className="icon-button" aria-label={t('modelHub.wizardCancel', '取消并返回')} onClick={() => { setWizard(undefined); void reload() }}><X size={16} /></button>
        </header>
        {wizard.step === 'source' ? <div className="model-hub__source-grid">
          {(catalog?.catalog.providers ?? []).map((entry) => <button type="button" key={entry.id} className="model-hub__source-card" onClick={() => openForm(entry)}>
            <strong>{entry.name}{entry.badge === undefined ? '' : ` · ${entry.badge}`}</strong>
            <span>{entry.description}</span>
          </button>)}
          <button type="button" className="model-hub__source-card is-manual" onClick={() => openForm(undefined, 'custom')}><strong>{t('modelHub.sourceCustom', '自定义 HTTPS 服务')}</strong><span>{t('modelHub.sourceCustomHint', '连接其他可信的 OpenAI 兼容网关。')}</span></button>
          <button type="button" className="model-hub__source-card is-manual" onClick={() => openForm(undefined, 'local')}><strong>{t('modelHub.sourceLocal', '本机 / 局域网推理服务')}</strong><span>{t('modelHub.sourceLocalHint', 'vLLM、Ollama、LM Studio、Sub2API 等 HTTP 端点。')}</span></button>
        </div> : null}
        {wizard.step === 'form' ? <div className="model-hub__form">
          {wizard.entry !== undefined ? <p className="model-hub__signup">{wizard.entry.signup.text} <a href={wizard.entry.signup.url} target="_blank" rel="noopener noreferrer">{t('modelHub.openSignup', '打开注册页 ↗')}</a></p> : null}
          <label><span>{t('modelHub.fieldName', '名称')}</span><input value={wizard.form.name} onChange={(event) => setWizard({ ...wizard, form: { ...wizard.form, name: event.target.value } })} maxLength={80} /></label>
          <label><span>{t('modelHub.fieldBaseUrl', '接口地址 Base URL')}</span><input value={wizard.form.baseUrl} onChange={(event) => setWizard({ ...wizard, form: { ...wizard.form, baseUrl: event.target.value } })} placeholder={wizard.entry?.modelPlaceholder === undefined ? 'https://api.example.com/v1' : wizard.entry.baseUrl} /></label>
          <details className="model-hub__advanced"><summary>{t('modelHub.advanced', '高级配置')}</summary>
            <label><span>{t('modelHub.fieldApi', '接口协议')}</span><select value={wizard.form.api} onChange={(event) => setWizard({ ...wizard, form: { ...wizard.form, api: event.target.value } })}><option value="openai-completions">OpenAI 对话补全</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic 消息协议</option></select></label>
            {wizard.form.providerKind !== 'openai-compatible-local' ? <label><span>{t('modelHub.fieldKey', 'API 密钥')}</span><input type="password" value={wizard.form.apiKey} onChange={(event) => setWizard({ ...wizard, form: { ...wizard.form, apiKey: event.target.value } })} placeholder={wizard.editing !== undefined && !wizard.editing.credentialConfigured ? t('modelHub.keyPlaceholderUnset', '尚未配置') : t('modelHub.keyPlaceholderKeep', '留空则保持不变')} autoComplete="off" /></label> : null}
          </details>
          <footer>
            <button type="button" className="primary-button" disabled={busy === 'test' || !wizard.form.name.trim() || !wizard.form.baseUrl.trim()} onClick={() => void runWizardTest(wizard)}>{busy === 'test' ? t('modelHub.testing', '正在测试并获取模型…') : t('modelHub.testFetch', '测试服务商并获取模型列表')}</button>
          </footer>
        </div> : null}
        {wizard.step === 'models' ? <div className="model-hub__models-step">
          <p>{t('modelHub.modelsFound', '获取到 {count} 个模型，勾选后导入模型池。', { count: wizard.models.length })}</p>
          <ul>{wizard.models.map((model) => <li key={model.id}>
            <label><input type="checkbox" checked={wizard.selected.has(model.id)} onChange={() => setWizard({ ...wizard, selected: toggleSelection(wizard.selected, model.id) })} />
              <span><strong>{model.displayName ?? model.id}</strong><code>{model.id}</code>{model.contextLength === undefined ? null : <small>{t('modelHub.contextBadge', '上下文 {tokens}', { tokens: model.contextLength.toLocaleString() })}</small>}</span>
            </label>
          </li>)}</ul>
          <footer>
            <span>{t('modelHub.selectedCount', '已选 {count} 个', { count: Math.min(wizard.selected.size, IMPORT_CAP) })}</span>
            <button type="button" className="primary-button" disabled={busy === 'import'} onClick={() => void confirmImport(wizard)}>{busy === 'import' ? t('modelHub.importing', '正在导入…') : t('modelHub.import', '保存并导入模型池')}</button>
          </footer>
        </div> : null}
      </div> : null}
    </section>
  </div>
}
