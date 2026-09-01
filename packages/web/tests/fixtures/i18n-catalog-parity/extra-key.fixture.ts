// A stray key that only en-US has must fail too, otherwise a rename would leave
// eleven locales pointing at a key nobody reads.
import { defineLocaleCatalogs } from '../../../src/i18n/catalog-parity.js'

export const catalogs = defineLocaleCatalogs({
  'zh-CN': { alpha: '甲' },
  'zh-TW': { alpha: '甲' },
  'en-US': { alpha: 'Alpha', strayKey: 'Stray' },
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
