// The typing this change replaced, kept as executable evidence of the hole:
// `as const satisfies Record<UiLocale, Record<string, string>>` accepts a key
// that exists in one locale only, so this fixture typechecks CLEAN. The test
// asserts that, then asserts the same shape through defineLocaleCatalogs does
// not — which is exactly the regression the parity helper closes.
import type { UiLocale } from '@dsh-cyber/contracts'

export const catalogs = {
  'zh-CN': { alpha: '甲', beta: '乙' },
  'zh-TW': { alpha: '甲' },
  'en-US': { alpha: 'Alpha' },
  'ja-JP': { alpha: 'アルファ' },
  'ko-KR': { alpha: '알파' },
  'es-ES': { alpha: 'Alfa' },
  'fr-FR': { alpha: 'Alpha' },
  'de-DE': { alpha: 'Alpha' },
  'pt-BR': { alpha: 'Alfa' },
  'ru-RU': { alpha: 'Альфа' },
  'ar-SA': { alpha: 'ألفا' },
  'hi-IN': { alpha: 'अल्फ़ा' },
} as const satisfies Record<UiLocale, Record<string, string>>
