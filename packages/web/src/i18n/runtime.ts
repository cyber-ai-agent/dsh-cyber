import { useCallback, useSyncExternalStore } from 'react'
import { isUiLocale, type UiLocale } from '@dsh-cyber/contracts'

export const UI_LOCALE_STORAGE_KEY = 'dsh-cyber.ui-locale'

export const UI_LOCALES: ReadonlyArray<{
  id: UiLocale
  nativeName: string
  englishName: string
  direction: 'ltr' | 'rtl'
}> = [
  { id: 'zh-CN', nativeName: '简体中文', englishName: 'Simplified Chinese', direction: 'ltr' },
  { id: 'zh-TW', nativeName: '繁體中文', englishName: 'Traditional Chinese', direction: 'ltr' },
  { id: 'en-US', nativeName: 'English', englishName: 'English', direction: 'ltr' },
  { id: 'ja-JP', nativeName: '日本語', englishName: 'Japanese', direction: 'ltr' },
  { id: 'ko-KR', nativeName: '한국어', englishName: 'Korean', direction: 'ltr' },
  { id: 'es-ES', nativeName: 'Español', englishName: 'Spanish', direction: 'ltr' },
  { id: 'fr-FR', nativeName: 'Français', englishName: 'French', direction: 'ltr' },
  { id: 'de-DE', nativeName: 'Deutsch', englishName: 'German', direction: 'ltr' },
  { id: 'pt-BR', nativeName: 'Português (Brasil)', englishName: 'Portuguese', direction: 'ltr' },
  { id: 'ru-RU', nativeName: 'Русский', englishName: 'Russian', direction: 'ltr' },
  { id: 'ar-SA', nativeName: 'العربية', englishName: 'Arabic', direction: 'rtl' },
  { id: 'hi-IN', nativeName: 'हिन्दी', englishName: 'Hindi', direction: 'ltr' },
]

export type MessageVariables = Record<string, string | number>
export type MessageCatalog = Readonly<Record<string, string>>

const catalogs = new Map<UiLocale, MessageCatalog>()
const listeners = new Set<() => void>()
let activeLocale = bootLocale()

export function registerMessages(locale: UiLocale, messages: MessageCatalog): void {
  catalogs.set(locale, { ...(catalogs.get(locale) ?? {}), ...messages })
}

export function getUiLocale(): UiLocale { return activeLocale }

export function setUiLocale(locale: UiLocale): void {
  if (activeLocale === locale) {
    applyDocumentLocale(locale)
    return
  }
  activeLocale = locale
  try { window.localStorage.setItem(UI_LOCALE_STORAGE_KEY, locale) } catch { /* optional storage */ }
  applyDocumentLocale(locale)
  for (const listener of listeners) listener()
}

export function translate(key: string, fallback: string, variables: MessageVariables = {}, locale = activeLocale): string {
  const template = catalogs.get(locale)?.[key]
    ?? catalogs.get('en-US')?.[key]
    ?? catalogs.get('zh-CN')?.[key]
    ?? fallback
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => String(variables[name] ?? match))
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getUiLocale, getUiLocale)
  const t = useCallback((key: string, fallback: string, variables?: MessageVariables) => translate(key, fallback, variables, locale), [locale])
  const formatNumber = useCallback((value: number) => new Intl.NumberFormat(locale).format(value), [locale])
  const formatDateTime = useCallback((value: string | number | Date, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(new Date(value)), [locale])
  const formatList = useCallback((values: string[], options?: Intl.ListFormatOptions) => new Intl.ListFormat(locale, options).format(values), [locale])
  return { locale, t, formatNumber, formatDateTime, formatList, direction: directionOf(locale) }
}

export function resolveUiLocale(value: unknown): UiLocale {
  if (isUiLocale(value)) return value
  if (typeof value !== 'string') return 'zh-CN'
  const normalized = value.toLowerCase()
  const exact = UI_LOCALES.find((item) => item.id.toLowerCase() === normalized)
  if (exact !== undefined) return exact.id
  if (/^zh-(hant|tw|hk|mo)(-|$)/.test(normalized)) return 'zh-TW'
  if (/^zh-(hans|cn|sg)(-|$)/.test(normalized)) return 'zh-CN'
  const language = normalized.split('-')[0]
  return UI_LOCALES.find((item) => item.id.toLowerCase().startsWith(`${language}-`))?.id ?? 'zh-CN'
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function bootLocale(): UiLocale {
  if (typeof document !== 'undefined') {
    const booted = document.documentElement.dataset.locale
    if (isUiLocale(booted)) return booted
  }
  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem(UI_LOCALE_STORAGE_KEY)
      if (saved !== null) return resolveUiLocale(saved)
    } catch { /* optional storage */ }
    return resolveUiLocale(window.navigator.languages?.[0] ?? window.navigator.language)
  }
  return 'zh-CN'
}

function directionOf(locale: UiLocale): 'ltr' | 'rtl' {
  return UI_LOCALES.find((item) => item.id === locale)?.direction ?? 'ltr'
}

function applyDocumentLocale(locale: UiLocale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
  document.documentElement.dir = directionOf(locale)
  document.documentElement.dataset.locale = locale
}

applyDocumentLocale(activeLocale)
