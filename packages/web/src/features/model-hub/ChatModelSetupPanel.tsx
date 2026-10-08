import { useState } from 'react'
import { Plus } from '@phosphor-icons/react'
import { useI18n } from '../../i18n/runtime.js'
import type { HubProfile, HubProvider } from './api.js'

export interface ModelHubChatContext {
  worldId: string
  worldName: string
  employeeId?: string
  employeeName?: string
}

/** Explicit handoff: importing a directory never selects or assigns a model. */
export function ChatModelSetupPanel({ context, profiles, providers, loaded, loadFailed, busy, applying, importedModels, onRetry, onShowAll, onAddProvider, onManageProviders, onApply }: {
  context: ModelHubChatContext
  profiles: HubProfile[]
  providers: HubProvider[]
  loaded: boolean
  loadFailed: boolean
  busy: boolean
  applying: boolean
  importedModels: { providerId: string; modelIds: string[] } | undefined
  onRetry(): void
  onShowAll(): void
  onAddProvider(): void
  onManageProviders(): void
  onApply(profileId: string): void
}) {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState('')
  const choices = importedModels === undefined ? profiles : profiles.filter((profile) =>
    profile.providerId === importedModels.providerId && importedModels.modelIds.includes(profile.modelId),
  )
  const selected = choices.find((profile) => profile.id === selectedId)

  return <div className="model-hub__chat-setup">
    <div className="model-hub__chat-heading">
      <h3>{importedModels === undefined
        ? t('modelHub.chat.choose', '选择此对话要使用的模型')
        : t('modelHub.chat.imported', '模型已导入，请选择一个用于此对话')}</h3>
      <p>{t('modelHub.chat.unverified', '模型目录只说明服务商列出了这些模型，尚未验证对话或工具调用能力。')}</p>
    </div>
    {loadFailed ? <div className="model-hub__chat-tools"><button type="button" disabled={busy} onClick={onRetry}>{t('modelHub.chat.retryLoad', '重新读取模型配置')}</button></div> : null}
    {!loaded && !loadFailed ? <p role="status">{t('modelHub.chat.loading', '正在读取模型配置…')}</p>
      : !loaded ? null : choices.length === 0 ? <div className="model-hub__empty">
        <strong>{t('modelHub.chat.empty', '还没有可选择的模型')}</strong>
        <span>{t('modelHub.chat.emptyHint', '先保存服务商并导入模型，再选择此对话的使用范围。')}</span>
      </div>
      : <fieldset className="model-hub__chat-choices" disabled={busy}>
        <legend>{t('modelHub.chat.modelLabel', '选择模型')}</legend>
        {choices.map((profile) => <label key={profile.id} className={profile.id === selectedId ? 'is-selected' : ''}>
          <input type="radio" name="chat-setup-model" value={profile.id} checked={profile.id === selectedId} onChange={() => setSelectedId(profile.id)} />
          <span><strong>{profile.displayName}</strong><small>{providers.find((provider) => provider.id === profile.providerId)?.name ?? t('modelHub.legacyConnection', '独立配置')} · {profile.modelId}</small></span>
        </label>)}
      </fieldset>}
    <div className="model-hub__chat-tools">
      <button type="button" disabled={busy || !loaded} onClick={onAddProvider}><Plus size={14} />{t('modelHub.addProvider', '添加服务商')}</button>
      {providers.length === 0 ? null : <button type="button" disabled={busy} onClick={onManageProviders}>{t('modelHub.chat.manage', '编辑服务商或导入模型')}</button>}
      {importedModels === undefined ? null : <button type="button" disabled={busy} onClick={onShowAll}>{t('modelHub.chat.showAll', '选择模型池中的其他模型')}</button>}
    </div>
    <footer className="model-hub__chat-footer">
      <p aria-live="polite">{selected === undefined
        ? t('modelHub.chat.chooseHint', '请先选择一个模型；返回对话不会自动发送消息。')
        : t('modelHub.chat.selected', '已选「{name}」。保存后返回对话，由你发送消息。', { name: selected.displayName })}</p>
      <button type="button" className="primary-button" disabled={busy || selected === undefined} onClick={() => { if (selected !== undefined) onApply(selected.id) }}>
        {applying ? t('modelHub.chat.applying', '正在保存此对话的选择…')
          : context.employeeId === undefined ? t('modelHub.chat.applyWorld', '用于当前世界并返回对话')
          : t('modelHub.chat.applyEmployee', '用于当前角色并返回对话')}
      </button>
    </footer>
  </div>
}
