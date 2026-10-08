import type { ConversationModelReadiness } from '@dsh-cyber/contracts'
import { Stack, WarningCircle } from '@phosphor-icons/react'
import { useI18n } from '../../i18n/runtime.js'
import './messages.js'
import './chat-model-setup.css'

export function ChatModelReadiness({ readiness, failed, employeeNames, onOpen, compact = false }: {
  readiness?: ConversationModelReadiness | undefined
  failed?: boolean | undefined
  employeeNames: ReadonlyMap<string, string>
  onOpen(): void
  compact?: boolean
}) {
  const { t } = useI18n()
  const blocked = readiness?.canSend === false
  const missing = readiness?.items.some((item) => item.state === 'missing-credential')
  const title = readiness === undefined
    ? failed ? t('chatModel.unknown', '暂时无法读取模型配置') : t('chatModel.loading', '正在读取模型配置…')
    : blocked ? readiness.items.length > 1 ? t('chatModel.group', '部分角色需要配置模型') : missing ? t('chatModel.missing', '当前模型还缺少密钥') : t('chatModel.none', '先连接一个模型')
      : t('chatModel.unverified', '已配置 · 对话连接未验证')
  if (compact) return <button className="chat-model-entry" type="button" onClick={onOpen} aria-label={t('chatModel.edit', '更换或检查模型')} title={[title, ...readiness?.items.map((item) => `${item.displayName ?? item.modelId ?? ''} · ${t(`chatModel.source.${item.source}`, item.source)}`) ?? []].join('\n')}>
    {blocked ? <WarningCircle size={15} /> : <Stack size={15} />}
    <span>{blocked ? title : readiness?.items.length === 1 ? readiness.items[0]?.displayName ?? t('chatModel.title', '对话模型') : t('chatModel.title', '对话模型')}</span>
  </button>
  return <section className={`chat-model-readiness${blocked ? ' is-blocked' : ''}`} aria-label={t('chatModel.title', '对话模型')}>
    <strong>{title}</strong>
    {readiness?.items.filter((item) => readiness.items.length > 1 || item.state !== 'none').map((item) => <p key={item.employeeId}>
      {readiness.items.length > 1 ? `${employeeNames.get(item.employeeId) ?? ''} · ` : ''}
      {item.displayName ?? item.modelId ?? (item.state === 'none' ? t('chatModel.none', '先连接一个模型') : t(`chatModel.source.${item.source}`, item.source))}
      {item.state === 'missing-credential' && readiness.items.length > 1 ? <> · {t('chatModel.missing', '当前模型还缺少密钥')}</> : null}
      {item.state === 'none' || item.displayName === undefined && item.modelId === undefined ? null : <> · {t(`chatModel.source.${item.source}`, item.source)}</>}
    </p>)}
    {blocked ? <p>{t('chatModel.hint', '在模型中心连接服务商，选择用于当前角色或世界的模型，再回来发送。草稿和附件会保留。')}</p> : null}
    <button className={blocked ? 'primary-button' : 'secondary-button'} type="button" onClick={onOpen}>{blocked ? t('chatModel.open', '配置对话模型') : t('chatModel.edit', '更换或检查模型')}</button>
  </section>
}
