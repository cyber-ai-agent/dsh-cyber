(() => {
  const supported = ['zh-CN','zh-TW','en-US','ja-JP','ko-KR','es-ES','fr-FR','de-DE','pt-BR','ru-RU','ar-SA','hi-IN']
  let candidate
  try { candidate = localStorage.getItem('dsh-cyber.ui-locale') } catch {}
  candidate ||= navigator.languages?.[0] || navigator.language || 'zh-CN'
  const exact = supported.find((locale) => locale.toLowerCase() === candidate.toLowerCase())
  const normalized = candidate.toLowerCase()
  const language = normalized.split('-')[0]
  const chinese = /^zh-(hant|tw|hk|mo)(-|$)/.test(normalized) ? 'zh-TW' : /^zh-(hans|cn|sg)(-|$)/.test(normalized) ? 'zh-CN' : undefined
  const locale = exact || chinese || supported.find((item) => item.toLowerCase().startsWith(`${language}-`)) || 'zh-CN'
  document.documentElement.lang = locale
  document.documentElement.dir = locale === 'ar-SA' ? 'rtl' : 'ltr'
  document.documentElement.dataset.locale = locale
})()
