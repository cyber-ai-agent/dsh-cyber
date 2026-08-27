export const SUPPORTED_UI_LOCALES = [
  'zh-CN',
  'zh-TW',
  'en-US',
  'ja-JP',
  'ko-KR',
  'es-ES',
  'fr-FR',
  'de-DE',
  'pt-BR',
  'ru-RU',
  'ar-SA',
  'hi-IN',
] as const

export type UiLocale = typeof SUPPORTED_UI_LOCALES[number]

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && (SUPPORTED_UI_LOCALES as readonly string[]).includes(value)
}
