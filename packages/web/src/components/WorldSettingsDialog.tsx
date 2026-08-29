import {
  CheckCircle,
  Cpu,
  Info,
  MagnifyingGlass,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  UserCircle,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentPermissionMode, ModelProfile, ReasoningEffort, World, WorldSettings } from '@dsh-cyber/contracts'

import { useDialogFocusTrap } from './useDialogFocusTrap.js'
import { ModelPicker } from '../features/models/ModelPicker.js'
import { applyWorldTheme, DEFAULT_SKIN_ID, readWorldTheme, saveWorldTheme, themeRegistry } from '../features/world/world-themes.js'
import { useI18n } from '../i18n/runtime.js'

interface WorldSettingsDialogProps {
  world: World
  value: WorldSettings
  models: ModelProfile[]
  installedSkinIds?: readonly string[]
  saving: boolean
  onClose(): void
  onSave(value: WorldSettings): Promise<void>
}

type WorldManagementTab = 'basic' | 'visual' | 'model' | 'permissions'

export function WorldSettingsDialog({
  world,
  value,
  models,
  installedSkinIds,
  saving,
  onClose,
  onSave,
}: WorldSettingsDialogProps) {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<WorldManagementTab>('basic')
  const [draft, setDraft] = useState(normalizeWorldSettings(value))
  const [notice, setNotice] = useState<string | undefined>()
  const [error, setError] = useState<string>()
  const savedRef = useRef(false)
  const dialogRef = useRef<HTMLElement>(null)

  const [selectedThemeId, setSelectedThemeId] = useState<string>(() => readWorldTheme(world))
  const initialThemeIdRef = useRef<string>(readWorldTheme(world))
  const [skinQuery, setSkinQuery] = useState('')

  const defaultGlobalModel = useMemo(() => {
    return models.find((m) => m.isDefault) ?? models[0]
  }, [models])

  const defaultGlobalModelLabel = useMemo(() => {
    if (!defaultGlobalModel) return t('worldSettings.noModelConfigured', '未配置模型')
    return defaultGlobalModel.modelId || defaultGlobalModel.displayName
  }, [defaultGlobalModel, t])

  const reasoningOptions: Array<[ReasoningEffort, string]> = useMemo(() => [
    ['auto', t('worldSettings.reasoningAuto', '自动（Auto）')],
    ['off', t('worldSettings.reasoningOff', '关闭推理')],
    ['minimal', t('worldSettings.reasoningMinimal', '极低')],
    ['low', t('worldSettings.reasoningLow', '低')],
    ['medium', t('worldSettings.reasoningMedium', '中（默认）')],
    ['high', t('worldSettings.reasoningHigh', '高')],
    ['max', t('worldSettings.reasoningMax', '最大')],
  ], [t])

  const close = () => {
    applyWorldPreview(value)
    applyWorldTheme(initialThemeIdRef.current)
    onClose()
  }

  useDialogFocusTrap(dialogRef, close)

  useEffect(() => {
    setDraft(normalizeWorldSettings(value))
    applyWorldPreview(value)
    const persisted = readWorldTheme(world)
    const available = themeRegistry.listAvailable(installedSkinIds ?? [])
    const resolvedThemeId = available.some((theme) => theme.id === persisted) ? persisted : DEFAULT_SKIN_ID
    initialThemeIdRef.current = resolvedThemeId
    setSelectedThemeId(resolvedThemeId)
  }, [installedSkinIds, value, world])

  useEffect(() => {
    applyWorldPreview(draft)
  }, [draft])

  const availableThemes = themeRegistry.listAvailable(installedSkinIds ?? [])
  const visibleSelectedThemeId = availableThemes.some((theme) => theme.id === selectedThemeId)
    ? selectedThemeId
    : DEFAULT_SKIN_ID

  const filteredThemes = useMemo(() => {
    const q = skinQuery.trim().toLowerCase()
    if (!q) return availableThemes
    return availableThemes.filter(
      (theme) =>
        theme.displayName.toLowerCase().includes(q) ||
        theme.description.toLowerCase().includes(q) ||
        theme.id.toLowerCase().includes(q) ||
        theme.author.toLowerCase().includes(q),
    )
  }, [availableThemes, skinQuery])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(undefined)
    setNotice(undefined)
    try {
      saveWorldTheme(world.id, visibleSelectedThemeId)
      await onSave(draft)
      savedRef.current = true
      setNotice(t('worldSettings.savedNotice', '世界管理设定已保存'))
      window.setTimeout(onClose, 450)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('worldSettings.saveFailedNotice', '世界管理设定保存失败'))
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        ref={dialogRef}
        className="world-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="world-settings-title"
      >
        <header className="dialog-header">
          <div>
            <h2 id="world-settings-title">{t('worldSettings.title', '世界管理')} · {world.name}</h2>
            <p>{t('worldSettings.subtitleSceneV2', '世界规则、会话视觉、运行模型与角色交互权限只属于当前世界。')}</p>
          </div>
          <button
            data-dialog-initial-focus
            className="icon-button"
            onClick={close}
            aria-label={t('worldSettings.close', '关闭')}
          >
            <X size={18} />
          </button>
        </header>

        {notice ? (
          <div className="world-settings-feedback is-success" role="status">
            <CheckCircle size={16} />
            {notice}
          </div>
        ) : null}
        {error ? (
          <div className="world-settings-feedback is-error" role="alert">
            <WarningCircle size={16} />
            {error}
          </div>
        ) : null}

        <nav className="world-management-tabs" aria-label={t('worldSettings.tabNavigation', '世界管理分栏')}>
          <button
            type="button"
            className={`world-tab-btn ${activeTab === 'basic' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('basic')}
          >
            <SlidersHorizontal size={16} />
            <span>{t('worldSettings.tabBasic', '基础设定')}</span>
          </button>
          <button
            type="button"
            className={`world-tab-btn ${activeTab === 'visual' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('visual')}
          >
            <Palette size={16} />
            <span>{t('worldSettings.tabConversationSkin', '会话皮肤')}</span>
          </button>
          <button
            type="button"
            className={`world-tab-btn ${activeTab === 'model' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('model')}
          >
            <Cpu size={16} />
            <span>{t('worldSettings.tabModel', '模型运行')}</span>
          </button>
          <button
            type="button"
            className={`world-tab-btn ${activeTab === 'permissions' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('permissions')}
          >
            <ShieldCheck size={16} />
            <span>{t('worldSettings.tabPermissions', '技能权限')}</span>
          </button>
        </nav>

        <div className="world-settings-grid">
          <div className="world-tab-panel" hidden={activeTab !== 'basic'}>
            <section className="world-settings-card">
              <header className="world-settings-card__header">
                <span className="card-icon">
                  <SlidersHorizontal size={17} />
                </span>
                <div>
                  <h4>{t('worldSettings.loreCardTitle', '世界观设定')}</h4>
                  <small>{t('worldSettings.loreCardSubtitle', '定义当前世界的背景故事、世界规则与当前沉浸场景')}</small>
                </div>
              </header>
              <div className="world-settings-card__body">
                <div className="dialog-field">
                  <span>{t('worldSettings.loreLabel', '世界设定背景')}</span>
                  <textarea
                    rows={4}
                    value={draft.lore}
                    onChange={(event) => setDraft({ ...draft, lore: event.target.value })}
                    placeholder={t('worldSettings.lorePlaceholder', '例如：这是一个和风千年神殿。我是神主，巫女们熟悉神社规约与祭仪。')}
                  />
                </div>
                <div className="dialog-field">
                  <span>{t('worldSettings.scenarioLabel', '当前沉浸场景')}</span>
                  <textarea
                    rows={2}
                    value={draft.scenario}
                    onChange={(event) => setDraft({ ...draft, scenario: event.target.value })}
                    placeholder={t('worldSettings.scenarioPlaceholder', '例如：雨后落樱纷飞的古院回廊，阳光透落于石灯笼前。')}
                  />
                </div>
              </div>
            </section>

            <section className="world-settings-card">
              <header className="world-settings-card__header">
                <span className="card-icon">
                  <UserCircle size={17} />
                </span>
                <div>
                  <h4>{t('worldSettings.identityCardTitle', '你与角色身份')}</h4>
                  <small>{t('worldSettings.identityCardSubtitle', '设定你在当前世界的身份定位，以及角色对你的称呼')}</small>
                </div>
              </header>
              <div className="world-settings-card__body">
                <div className="dialog-field-grid">
                  <div className="dialog-field">
                    <span>{t('worldSettings.yourName', '你的名字')}</span>
                    <input
                      type="text"
                      value={draft.userIdentity.displayName}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          userIdentity: { ...draft.userIdentity, displayName: event.target.value },
                        })
                      }
                      placeholder={t('worldSettings.yourNamePlaceholder', '例如：指挥官 / 玩家名 / 神主')}
                    />
                  </div>
                  <div className="dialog-field">
                    <span>{t('worldSettings.yourRole', '你在本世界的身份')}</span>
                    <input
                      type="text"
                      value={draft.userIdentity.worldRole}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          userIdentity: { ...draft.userIdentity, worldRole: event.target.value },
                        })
                      }
                      placeholder={t('worldSettings.yourRolePlaceholder', '主人 / 院长 / 旅人 / 领航员')}
                    />
                  </div>
                </div>
                <div className="dialog-field">
                  <span>{t('worldSettings.addressAs', '角色默认如何称呼你')}</span>
                  <input
                    type="text"
                    value={draft.userIdentity.addressAs}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        userIdentity: { ...draft.userIdentity, addressAs: event.target.value },
                      })
                    }
                    placeholder={t('worldSettings.addressAsPlaceholder', '主人 / 院长 / 您的称谓')}
                  />
                </div>
                <div className="setting-help">
                  <Info size={15} />
                  <span>{t('worldSettings.identityHint', '这里是世界默认值。某个角色有特殊羁绊时，可在该角色档案里单独覆盖。')}</span>
                </div>
              </div>
            </section>

            <section className="world-settings-card world-settings-advanced">
              <header className="world-settings-card__header">
                <span className="card-icon">
                  <Sparkle size={17} />
                </span>
                <div>
                  <h4>{t('worldSettings.advancedTitle', '高级术语定制')}</h4>
                  <small>{t('worldSettings.advancedSubtitle', '自定义这个世界里的“角色 / 群聊 / 动作”等显示称谓')}</small>
                </div>
              </header>
              <div className="world-settings-card__body">
                <div className="dialog-field-grid">
                  <div className="dialog-field">
                    <span>{t('worldSettings.termCharSingular', '单个角色的类型名称')}</span>
                    <input
                      type="text"
                      value={draft.terminology.characterSingular}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          terminology: { ...draft.terminology, characterSingular: event.target.value },
                        })
                      }
                      placeholder={t('worldSettings.termCharSingularPlaceholder', '角色 / 巫女 / 居民 / 使魔')}
                    />
                  </div>
                  <div className="dialog-field">
                    <span>{t('worldSettings.termCharPlural', '多个角色的类型名称')}</span>
                    <input
                      type="text"
                      value={draft.terminology.characterPlural}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          terminology: { ...draft.terminology, characterPlural: event.target.value },
                        })
                      }
                    />
                  </div>
                </div>
                <div className="dialog-field-grid">
                  <div className="dialog-field">
                    <span>{t('worldSettings.termAddVerb', '添加角色动作动词')}</span>
                    <input
                      type="text"
                      value={draft.terminology.addCharacterVerb}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          terminology: { ...draft.terminology, addCharacterVerb: event.target.value },
                        })
                      }
                    />
                  </div>
                  <div className="dialog-field">
                    <span>{t('worldSettings.termGroupConv', '多人会话名称')}</span>
                    <input
                      type="text"
                      value={draft.terminology.groupConversation}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          terminology: { ...draft.terminology, groupConversation: event.target.value },
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div className="world-tab-panel" hidden={activeTab !== 'visual'}>
            <section className="world-settings-card world-visual-settings">
              <header className="world-settings-card__header">
                <span className="card-icon">
                  <Palette size={17} />
                </span>
                <div>
                  <h4>{t('worldSettings.conversationSkinCardTitle', '界面 / 会话皮肤')}</h4>
                  <small>{t('worldSettings.conversationSkinCardSubtitle', '为【{world}】选择聊天背景、气泡和界面氛围；不会覆盖右侧世界场景', { world: world.name })}</small>
                </div>
              </header>
              <div className="world-settings-card__body">
                <div className="setting-help">
                  <Info size={15} />
                  <span>{t('worldSettings.skinSceneSeparationHint', '皮肤只影响界面与会话背景。世界场景属于 World 本身，请在右侧世界视图的「世界场景」按钮中单独选择。')}</span>
                </div>
                <div className="world-skin-search-bar">
                  <MagnifyingGlass size={16} />
                  <input
                    type="text"
                    value={skinQuery}
                    onChange={(e) => setSkinQuery(e.target.value)}
                    placeholder={t('worldSettings.conversationSkinSearchPlaceholder', '搜索会话皮肤名称、风格或关键词（如：鲸鱼、魔女、樱、默认）…')}
                  />
                  {skinQuery ? (
                    <button
                      type="button"
                      className="clear-search-btn"
                      onClick={() => setSkinQuery('')}
                      aria-label={t('worldSettings.close', '清空搜索')}
                    >
                      <X size={14} />
                    </button>
                  ) : null}
                  <span className="skin-count-badge">{t('worldSettings.skinCount', '{count} 款皮肤', { count: filteredThemes.length })}</span>
                </div>

                {filteredThemes.length === 0 ? (
                  <div className="dialog-empty">{t('worldSettings.conversationSkinNoMatches', '未搜索到匹配的会话皮肤，请尝试修改关键词。')}</div>
                ) : (
                  <div className="world-theme-grid">
                    {filteredThemes.map((theme) => {
                      const active = visibleSelectedThemeId === theme.id
                      const previewImage = theme.tokens.backdropImage ?? theme.tokens.worldMapImage
                      return (
                        <div
                          key={theme.id}
                          className={`world-theme-card ${active ? 'is-active' : ''}`}
                          onClick={() => {
                            setSelectedThemeId(theme.id)
                            applyWorldTheme(theme.id)
                          }}
                        >
                          <div
                            className="world-theme-card__cover"
                            style={{
                              backgroundImage: previewImage ? `url("${previewImage}")` : undefined,
                              backgroundColor: previewImage ? undefined : theme.tokens.pageBackground,
                            }}
                          >
                            <div className="world-theme-card__overlay" />
                            {active ? (
                              <span className="theme-active-tag">
                                <CheckCircle size={13} weight="fill" />
                                {t('worldSettings.skinCurrentSelected', '当前选用')}
                              </span>
                            ) : null}
                            <div
                              className="theme-accent-indicator"
                              style={{ backgroundColor: theme.tokens.accentColor }}
                            />
                          </div>
                          <div className="world-theme-card__info">
                            <div className="world-theme-card__title">
                              <strong>{theme.displayName}</strong>
                              <small>{theme.author}</small>
                            </div>
                            <p>{theme.description}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                <div className="world-chat-preview" aria-label="聊天视觉实时预览">
                  <div className="world-chat-preview__header">
                    <span>{t('worldSettings.conversationSkinPreviewTitle', '当前会话皮肤实时预览')}</span>
                    <small>{t('worldSettings.conversationSkinPreviewSubtitle', '聊天背景和气泡随皮肤变化，World Scene 保持不变')}</small>
                  </div>
                  <span className="is-character">{t('worldSettings.conversationSkinPreviewRole', '角色：欢迎回来，聊天氛围已经切换。')}</span>
                  <span className="is-owner">{t('worldSettings.conversationSkinPreviewUser', '你：右侧世界场景仍保持当前世界自己的空间。')}</span>
                </div>
              </div>
            </section>
          </div>

          <div className="world-tab-panel" hidden={activeTab !== 'model'}>
            <section className="world-settings-card">
              <header className="world-settings-card__header">
                <span className="card-icon">
                  <Cpu size={17} />
                </span>
                <div>
                  <h4>{t('worldSettings.modelCardTitle', '模型与运行策略')}</h4>
                  <small>{t('worldSettings.modelCardSubtitle', '配置当前世界的默认大语言模型及推理策略')}</small>
                </div>
              </header>
              <div className="world-settings-card__body">
                <div className="dialog-field">
                  <span>{t('worldSettings.modelLabel', '世界默认模型')}</span>
                  <ModelPicker
                    models={models}
                    value={draft.model.defaultModelProfileId}
                    ariaLabel={t('worldSettings.modelLabel', '世界默认模型')}
                    inheritLabel={defaultGlobalModelLabel}
                    onChange={(modelProfileId) =>
                      setDraft({
                        ...draft,
                        model: modelProfileId
                          ? { ...draft.model, defaultModelProfileId: modelProfileId }
                          : {
                              reasoningEffort: draft.model.reasoningEffort,
                              responseLanguage: draft.model.responseLanguage,
                            },
                      })
                    }
                  />
                </div>
                <div className="dialog-field-grid">
                  <div className="dialog-field">
                    <span>{t('worldSettings.reasoningEffort', '默认推理强度')}</span>
                    <select
                      value={draft.model.reasoningEffort}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          model: { ...draft.model, reasoningEffort: event.target.value as ReasoningEffort },
                        })
                      }
                    >
                      {reasoningOptions.map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="dialog-field">
                    <span>{t('worldSettings.preferredLanguage', '回复偏好语言')}</span>
                    <select
                      value={draft.model.responseLanguage}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          model: {
                            ...draft.model,
                            responseLanguage: event.target.value as WorldSettings['model']['responseLanguage'],
                          },
                        })
                      }
                    >
                      <option value="zh-CN">{t('worldSettings.langZhCN', '简体中文（默认）')}</option>
                      <option value="auto">{t('worldSettings.langAuto', '跟随用户消息')}</option>
                      <option value="en-US">{t('worldSettings.langEnUS', 'English')}</option>
                    </select>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div className="world-tab-panel" hidden={activeTab !== 'permissions'}>
            <section className="world-settings-card">
              <header className="world-settings-card__header">
                <span className="card-icon">
                  <ShieldCheck size={17} />
                </span>
                <div>
                  <h4>{t('worldSettings.permissionsTitle', '技能与工具体系')}</h4>
                  <small>{t('worldSettings.permissionsSubtitle', '管理当前世界中角色能够调用的外部工具与系统权限')}</small>
                </div>
              </header>
              <div className="world-settings-card__body">
                <div className="setting-help">
                  <Info size={16} />
                  <div>
                    <strong>{t('worldSettings.permissionsHelpTitle', '技能与外部动作权限隔离设计：')}</strong>
                    <p style={{ margin: '4px 0 0', lineHeight: 1.6 }}>
                      {t('worldSettings.permissionsHelpDesc', '浏览器、外部网络连接、系统命令与第三方能力均属于角色的专属技能与工具。请在右侧「档案 → 技能与工具」中为具体角色单独授权与配置审批策略。')}
                    </p>
                  </div>
                </div>
                <div className="permission-matrix-hint">
                  <div className="hint-badge">
                    <strong>{t('worldSettings.dataScopeTitle', '当前世界数据范围')}</strong>
                    <span>{t('worldSettings.dataScopeDesc', '仅限于本世界绑定的独立目录与 SQLite 事实表')}</span>
                  </div>
                  <div className="hint-badge">
                    <strong>{t('worldSettings.auditTitle', '外部副作用审计')}</strong>
                    <span>{t('worldSettings.auditDesc', '所有技能调用与外部访问均实时记录在世界轨迹中')}</span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>

        <footer className="world-settings-dialog__footer">
          <small>{saving ? t('worldSettings.saving', '正在保存…') : notice ?? t('worldSettings.saveStatusSceneV2', '会话视觉修改实时生效，点击保存持久化当前世界配置')}</small>
          <div>
            <button type="button" className="secondary-button" onClick={close}>
              {t('worldSettings.cancel', '取消')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={saving}
              onClick={(e) => void submit(e)}
            >
              {saving ? t('worldSettings.saving', '正在保存…') : t('worldSettings.save', '保存世界管理')}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

function normalizeWorldSettings(settings: WorldSettings): WorldSettings {
  return settings.runtime.permissionMode === 'danger-full-access'
    ? { ...settings, runtime: { permissionMode: 'read-only' } }
    : settings
}

function applyWorldPreview(settings: WorldSettings): void {
  const root = document.documentElement
  const appearance = settings.appearance
  root.style.setProperty('--world-accent', appearance.accentColor)
  root.style.setProperty('--world-background', appearance.pageBackground)
  root.style.setProperty('--world-panel', appearance.panelBackground)
  root.style.setProperty('--world-owner-bubble', appearance.ownerBubbleColor)
  root.style.setProperty('--world-character-bubble', appearance.characterBubbleColor)
  root.style.setProperty('--world-text', appearance.textColor)
  root.style.setProperty('--world-muted', appearance.mutedTextColor)
  root.style.setProperty('--world-panel-radius', `${appearance.panelRadius}px`)
  root.style.setProperty('--world-bubble-radius', `${appearance.bubbleRadius}px`)
  root.style.setProperty('--world-button-radius', `${appearance.buttonRadius}px`)
  root.style.setProperty('--world-font-scale', String(appearance.fontScale))
}
