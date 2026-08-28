import { CaretDown, Check, MagnifyingGlass, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelProfile, UiLocale } from '@dsh-cyber/contracts'

import { useI18n } from '../../i18n/runtime.js'
import './ModelPicker.css'

export interface ModelPickerProps {
  models: readonly ModelProfile[]
  value?: string | undefined
  onChange(value: string | undefined): void
  inheritLabel?: string
  ariaLabel?: string
  disabled?: boolean
  initiallyOpen?: boolean
}

interface ModelPickerCopy {
  search: string
  chooseProvider: string
  providerCount: string
  modelCount: string
  configured: string
  needsConfiguration: string
  context: string
  capabilities: string
  inherit: string
  noModels: string
  noMatches: string
  clear: string
  localProvider: string
  remoteProvider: string
}

const COPY: Record<UiLocale, ModelPickerCopy> = {
  'zh-CN': {
    search: '搜索供应商、模型、ID 或能力', chooseProvider: '选择供应商', providerCount: '{count} 个模型', modelCount: '{count} 个模型', configured: '已配置', needsConfiguration: '需要配置', context: '上下文 {value}', capabilities: '能力 {value}', inherit: '继承上级 / 默认模型', noModels: '尚未配置模型', noMatches: '没有匹配的模型', clear: '清除模型选择', localProvider: '本地模型服务', remoteProvider: '远程模型服务',
  },
  'zh-TW': {
    search: '搜尋供應商、模型、ID 或能力', chooseProvider: '選擇供應商', providerCount: '{count} 個模型', modelCount: '{count} 個模型', configured: '已設定', needsConfiguration: '需要設定', context: '上下文 {value}', capabilities: '能力 {value}', inherit: '繼承上層／預設模型', noModels: '尚未設定模型', noMatches: '沒有符合的模型', clear: '清除模型選擇', localProvider: '本機模型服務', remoteProvider: '遠端模型服務',
  },
  'en-US': {
    search: 'Search providers, models, IDs, or capabilities', chooseProvider: 'Choose a provider', providerCount: '{count} models', modelCount: '{count} models', configured: 'Configured', needsConfiguration: 'Needs setup', context: 'Context {value}', capabilities: 'Capabilities {value}', inherit: 'Inherit from parent / default', noModels: 'No models configured', noMatches: 'No matching models', clear: 'Clear model selection', localProvider: 'Local model service', remoteProvider: 'Remote model service',
  },
  'ja-JP': {
    search: 'プロバイダー、モデル、ID、能力を検索', chooseProvider: 'プロバイダーを選択', providerCount: '{count} モデル', modelCount: '{count} モデル', configured: '設定済み', needsConfiguration: '要設定', context: 'コンテキスト {value}', capabilities: '能力 {value}', inherit: '上位／既定モデルを継承', noModels: 'モデル未設定', noMatches: '一致するモデルはありません', clear: 'モデル選択を解除', localProvider: 'ローカルモデルサービス', remoteProvider: 'リモートモデルサービス',
  },
  'ko-KR': {
    search: '공급자, 모델, ID 또는 기능 검색', chooseProvider: '공급자 선택', providerCount: '모델 {count}개', modelCount: '모델 {count}개', configured: '구성됨', needsConfiguration: '구성 필요', context: '컨텍스트 {value}', capabilities: '기능 {value}', inherit: '상위 / 기본 모델 상속', noModels: '구성된 모델 없음', noMatches: '일치하는 모델 없음', clear: '모델 선택 지우기', localProvider: '로컬 모델 서비스', remoteProvider: '원격 모델 서비스',
  },
  'es-ES': {
    search: 'Buscar proveedores, modelos, ID o capacidades', chooseProvider: 'Elegir proveedor', providerCount: '{count} modelos', modelCount: '{count} modelos', configured: 'Configurado', needsConfiguration: 'Requiere configuración', context: 'Contexto {value}', capabilities: 'Capacidades {value}', inherit: 'Heredar del nivel superior / predeterminado', noModels: 'No hay modelos configurados', noMatches: 'No hay modelos coincidentes', clear: 'Borrar selección de modelo', localProvider: 'Servicio de modelo local', remoteProvider: 'Servicio de modelo remoto',
  },
  'fr-FR': {
    search: 'Rechercher fournisseurs, modèles, ID ou capacités', chooseProvider: 'Choisir un fournisseur', providerCount: '{count} modèles', modelCount: '{count} modèles', configured: 'Configuré', needsConfiguration: 'Configuration requise', context: 'Contexte {value}', capabilities: 'Capacités {value}', inherit: 'Hériter du niveau supérieur / par défaut', noModels: 'Aucun modèle configuré', noMatches: 'Aucun modèle correspondant', clear: 'Effacer la sélection', localProvider: 'Service de modèle local', remoteProvider: 'Service de modèle distant',
  },
  'de-DE': {
    search: 'Anbieter, Modelle, IDs oder Fähigkeiten suchen', chooseProvider: 'Anbieter wählen', providerCount: '{count} Modelle', modelCount: '{count} Modelle', configured: 'Konfiguriert', needsConfiguration: 'Einrichtung erforderlich', context: 'Kontext {value}', capabilities: 'Fähigkeiten {value}', inherit: 'Übergeordnete / Standardauswahl übernehmen', noModels: 'Keine Modelle konfiguriert', noMatches: 'Keine passenden Modelle', clear: 'Modellauswahl löschen', localProvider: 'Lokaler Modelldienst', remoteProvider: 'Entfernter Modelldienst',
  },
  'pt-BR': {
    search: 'Buscar provedores, modelos, IDs ou capacidades', chooseProvider: 'Escolher provedor', providerCount: '{count} modelos', modelCount: '{count} modelos', configured: 'Configurado', needsConfiguration: 'Precisa de configuração', context: 'Contexto {value}', capabilities: 'Capacidades {value}', inherit: 'Herdar do nível superior / padrão', noModels: 'Nenhum modelo configurado', noMatches: 'Nenhum modelo encontrado', clear: 'Limpar seleção de modelo', localProvider: 'Serviço de modelo local', remoteProvider: 'Serviço de modelo remoto',
  },
  'ru-RU': {
    search: 'Поиск провайдеров, моделей, ID и возможностей', chooseProvider: 'Выберите провайдера', providerCount: 'Моделей: {count}', modelCount: 'Моделей: {count}', configured: 'Настроен', needsConfiguration: 'Требует настройки', context: 'Контекст {value}', capabilities: 'Возможности {value}', inherit: 'Наследовать верхний / стандартный выбор', noModels: 'Модели не настроены', noMatches: 'Совпадений нет', clear: 'Сбросить выбор модели', localProvider: 'Локальный сервис моделей', remoteProvider: 'Удалённый сервис моделей',
  },
  'ar-SA': {
    search: 'ابحث عن الموفرين أو النماذج أو المعرّفات أو القدرات', chooseProvider: 'اختر موفرًا', providerCount: '{count} نماذج', modelCount: '{count} نماذج', configured: 'مُعدّ', needsConfiguration: 'يحتاج إلى إعداد', context: 'السياق {value}', capabilities: 'القدرات {value}', inherit: 'توريث الإعداد الأعلى / الافتراضي', noModels: 'لا توجد نماذج مُعدة', noMatches: 'لا توجد نماذج مطابقة', clear: 'مسح اختيار النموذج', localProvider: 'خدمة نموذج محلية', remoteProvider: 'خدمة نموذج بعيدة',
  },
  'hi-IN': {
    search: 'प्रदाता, मॉडल, ID या क्षमताएँ खोजें', chooseProvider: 'प्रदाता चुनें', providerCount: '{count} मॉडल', modelCount: '{count} मॉडल', configured: 'कॉन्फ़िगर किया गया', needsConfiguration: 'सेटअप आवश्यक', context: 'कॉन्टेक्स्ट {value}', capabilities: 'क्षमताएँ {value}', inherit: 'ऊपरी / डिफ़ॉल्ट चयन अपनाएँ', noModels: 'कोई मॉडल कॉन्फ़िगर नहीं', noMatches: 'कोई मेल नहीं मिला', clear: 'मॉडल चयन हटाएँ', localProvider: 'स्थानीय मॉडल सेवा', remoteProvider: 'दूरस्थ मॉडल सेवा',
  },
}

interface ModelPickerGroup {
  id: string
  label: string
  models: readonly ModelProfile[]
}

export function modelPickerGroups(models: readonly ModelProfile[], locale: UiLocale): ModelPickerGroup[] {
  const groups = new Map<string, { label: string; models: ModelProfile[] }>()
  for (const model of models) {
    const providerId = settingText(model, 'providerId') ?? model.providerKind
    const isCustom = providerId === 'custom-local' || providerId === 'custom-remote'
    const key = isCustom ? `${providerId}:${model.id}` : providerId
    const label = settingText(model, 'providerName') ?? (isCustom
      ? model.displayName
      : providerLabel(providerId, locale))
    const group = groups.get(key)
    if (group) group.models.push(model)
    else groups.set(key, { label, models: [model] })
  }
  return [...groups.entries()]
    .map(([id, group]) => ({ id, label: group.label, models: group.models }))
    .sort((left, right) => left.label.localeCompare(right.label))
}

export function filterModelPickerGroups(groups: readonly ModelPickerGroup[], query: string): ModelPickerGroup[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return groups.map((group) => ({ ...group, models: [...group.models] }))
  return groups.flatMap((group) => {
    const providerMatches = `${group.label} ${group.id}`.toLocaleLowerCase().includes(needle)
    const models = providerMatches
      ? [...group.models]
      : group.models.filter((model) => modelSearchText(model).includes(needle))
    return models.length === 0 ? [] : [{ ...group, models }]
  })
}

export function ModelPicker({
  models,
  value,
  onChange,
  inheritLabel,
  ariaLabel,
  disabled = false,
  initiallyOpen = false,
}: ModelPickerProps) {
  const { locale } = useI18n()
  const copy = COPY[locale]
  const [open, setOpen] = useState(initiallyOpen)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const modelRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const needle = query.trim().toLocaleLowerCase()
  const filteredModels = useMemo(() => {
    if (!needle) return [...models]
    return models.filter((model) => modelSearchText(model).includes(needle))
  }, [models, needle])

  const selectedModel = models.find((model) => model.id === value)

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    searchRef.current?.focus()
  }, [open])

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  const selectModel = (modelId: string | undefined) => {
    onChange(modelId)
    close()
  }
  const displayLabel = selectedModel === undefined
    ? inheritLabel ?? copy.inherit
    : selectedModel.displayName && selectedModel.displayName !== selectedModel.modelId
      ? `${selectedModel.displayName} · ${selectedModel.modelId}`
      : selectedModel.modelId

  return (
    <div className={`model-picker${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="model-picker__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel ?? copy.chooseProvider}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={selectedModel === undefined ? 'model-picker__trigger-label is-inherited' : 'model-picker__trigger-label'}>{displayLabel}</span>
        <CaretDown size={15} aria-hidden="true" />
      </button>

      {open ? (
        <div className="model-picker__panel" role="dialog" aria-label={ariaLabel ?? copy.chooseProvider}>
          <div className="model-picker__search-row">
            <MagnifyingGlass size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder={copy.search}
              aria-label={copy.search}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); close() }
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  const firstModel = filteredModels[0]
                  if (firstModel) modelRefs.current[firstModel.id]?.focus()
                }
              }}
            />
            {query ? (
              <button type="button" className="model-picker__clear" aria-label={copy.clear} onClick={() => setQuery('')}>
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <div className="model-picker__summary-row">
            <span>{format(copy.providerCount, filteredModels.length)}</span>
          </div>

          <div className="model-picker__list" role="listbox" aria-label={format(copy.modelCount, filteredModels.length)}>
            {filteredModels.length === 0 ? (
              <span className="model-picker__empty">{models.length === 0 ? copy.noModels : copy.noMatches}</span>
            ) : (
              filteredModels.map((model) => {
                const capabilities = modelCapabilities(model)
                const contextWindow = modelSettingNumber(model, 'contextWindow')
                const configured = modelConfigured(model)
                const rawProvider = settingText(model, 'providerId') ?? model.providerKind
                const pName = settingText(model, 'providerName') ?? providerLabel(rawProvider, locale)
                const isSelected = model.id === value
                const isDifferentId = Boolean(model.displayName && model.modelId && model.displayName.trim() !== model.modelId.trim())
                return (
                  <button
                    key={model.id}
                    ref={(element) => { modelRefs.current[model.id] = element }}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    title={configured ? copy.configured : copy.needsConfiguration}
                    className={`model-picker__model-item${isSelected ? ' is-selected' : ''}`}
                    onClick={() => selectModel(model.id)}
                  >
                    <div className="model-picker__model-heading">
                      <strong>{model.displayName || model.modelId}</strong>
                      <Check size={14} aria-hidden="true" />
                    </div>
                    {isDifferentId ? <div className="model-picker__model-id">{model.modelId}</div> : null}
                    <div className="model-picker__model-meta">
                      {pName ? <small className="is-provider">{pName}</small> : null}
                      {configured ? null : <small className="is-needs-configuration">{copy.needsConfiguration}</small>}
                      {contextWindow === undefined ? null : <small>{format(copy.context, formatNumber(contextWindow, locale))}</small>}
                      {capabilities === undefined ? null : <small>{format(copy.capabilities, capabilities.join(', '))}</small>}
                    </div>
                  </button>
                )
              })
            )}
          </div>

          <button type="button" className="model-picker__inherit" onClick={() => selectModel(undefined)}>
            <span>{inheritLabel ?? copy.inherit}</span>
            {selectedModel === undefined ? <Check size={14} aria-hidden="true" /> : null}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function settingText(model: ModelProfile, key: string): string | undefined {
  const value = model.settings[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function modelSearchText(model: ModelProfile): string {
  const capabilities = modelCapabilities(model)?.join(' ') ?? ''
  return `${model.displayName} ${model.modelId} ${model.id} ${settingText(model, 'providerId') ?? ''} ${capabilities}`.toLocaleLowerCase()
}

function modelCapabilities(model: ModelProfile): string[] | undefined {
  const value = model.settings.capabilities
  if (!Array.isArray(value)) return undefined
  const capabilities = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, 12)
  return capabilities.length === 0 ? undefined : capabilities
}

function modelSettingNumber(model: ModelProfile, key: string): number | undefined {
  const value = model.settings[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function modelConfigured(model: ModelProfile): boolean {
  const explicit = (model as ModelProfile & { credentialConfigured?: unknown }).credentialConfigured
  if (typeof explicit === 'boolean') return explicit
  return model.providerKind === 'openai-compatible-local' || model.credentialEnvName !== undefined
}

function providerLabel(providerId: string, locale: UiLocale): string {
  const known: Record<string, string> = {
    deepseek: 'DeepSeek',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    gemini: 'Google Gemini',
    openrouter: 'OpenRouter',
    groq: 'Groq',
    mistral: 'Mistral',
    xai: 'xAI',
    'custom-remote': COPY[locale].remoteProvider,
    'custom-local': COPY[locale].localProvider,
    'openai-compatible-local': COPY[locale].localProvider,
    'openai-compatible-remote': COPY[locale].remoteProvider,
  }
  return known[providerId] ?? providerId
}

function format(template: string, value: string | number): string {
  return template.replace('{count}', String(value)).replace('{value}', String(value))
}

function formatNumber(value: number, locale: UiLocale): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}
