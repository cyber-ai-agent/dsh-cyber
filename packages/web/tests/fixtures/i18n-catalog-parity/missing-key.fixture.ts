// `beta` exists only in zh-CN. This is the defect the parity helper exists to
// catch, so this fixture MUST fail to typecheck.
import { defineLocaleCatalogs } from '../../../src/i18n/catalog-parity.js'

export const catalogs = defineLocaleCatalogs({
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
})
