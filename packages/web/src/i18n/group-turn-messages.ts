import type { UiLocale } from '@dsh-cyber/contracts'

import { registerMessages } from './runtime.js'

export const GROUP_TURN_MESSAGES = {
  'zh-CN': '按角色分配（{count} 个模型）',
  'zh-TW': '依角色分配（{count} 個模型）',
  'en-US': 'Per-role routing ({count} models)',
  'ja-JP': '役割別に割り当て（{count}モデル）',
  'ko-KR': '역할별 할당(모델 {count}개)',
  'es-ES': 'Enrutamiento por rol ({count} modelos)',
  'fr-FR': 'Routage par rôle ({count} modèles)',
  'de-DE': 'Routing pro Rolle ({count} Modelle)',
  'pt-BR': 'Roteamento por papel ({count} modelos)',
  'ru-RU': 'Маршрутизация по ролям ({count} моделей)',
  'ar-SA': 'توجيه حسب الدور ({count} نماذج)',
  'hi-IN': 'भूमिका के अनुसार रूटिंग ({count} मॉडल)',
} as const satisfies Record<UiLocale, string>

for (const [locale, message] of Object.entries(GROUP_TURN_MESSAGES) as Array<[UiLocale, string]>) {
  registerMessages(locale, { 'workbench.modelPerCharacter': message })
}
