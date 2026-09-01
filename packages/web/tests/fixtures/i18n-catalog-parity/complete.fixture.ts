// Every locale declares the same key set, so this fixture must typecheck.
// `beta` is deliberately untranslated for ja-JP and is written down as null.
import { defineLocaleCatalogs } from '../../../src/i18n/catalog-parity.js'

export const catalogs = defineLocaleCatalogs({
  'zh-CN': { alpha: '甲', beta: '乙' },
  'zh-TW': { alpha: '甲', beta: '乙' },
  'en-US': { alpha: 'Alpha', beta: 'Beta' },
  'ja-JP': { alpha: 'アルファ', beta: null },
  'ko-KR': { alpha: '알파', beta: '베타' },
  'es-ES': { alpha: 'Alfa', beta: 'Beta' },
  'fr-FR': { alpha: 'Alpha', beta: 'Bêta' },
  'de-DE': { alpha: 'Alpha', beta: 'Beta' },
  'pt-BR': { alpha: 'Alfa', beta: 'Beta' },
  'ru-RU': { alpha: 'Альфа', beta: 'Бета' },
  'ar-SA': { alpha: 'ألفا', beta: 'بيتا' },
  'hi-IN': { alpha: 'अल्फ़ा', beta: 'बीटा' },
})
