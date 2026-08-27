import type { UiLocale } from '@dsh-cyber/contracts'
import { registerMessages } from './runtime.js'

const catalogs = {
  'zh-CN': { currentWorld: '当前世界：', switchWorld: '切换世界', history: '查看历史消息', startChat: '开始与角色对话', startChatHint: '历史记录保留在当前世界；发送消息后角色才会开始处理。', composer: '发送消息给 {name}', approval: '请求批准', worldSettings: '世界设置', restoring: '正在恢复本地世界…' },
  'zh-TW': { currentWorld: '目前世界：', switchWorld: '切換世界', history: '歷史訊息', startChat: '開始與角色對話', startChatHint: '歷史記錄保留在目前世界；傳送訊息後角色才會開始處理。', composer: '傳送訊息給 {name}', approval: '請求核准', worldSettings: '世界設定', restoring: '正在恢復本機世界…' },
  'en-US': { currentWorld: 'Current world:', switchWorld: 'Switch world', history: 'Message history', startChat: 'Start a conversation', startChatHint: 'History stays in this world. The role starts working after you send a message.', composer: 'Message {name}', approval: 'Request approval', worldSettings: 'World settings', restoring: 'Restoring local worlds…' },
  'ja-JP': { currentWorld: '現在のワールド：', switchWorld: 'ワールドを切り替え', history: 'メッセージ履歴', startChat: '役割との会話を開始', startChatHint: '履歴はこのワールドに保存されます。メッセージ送信後に役割が処理を開始します。', composer: '{name} にメッセージを送信', approval: '承認を依頼', worldSettings: 'ワールド設定', restoring: 'ローカルワールドを復元中…' },
  'ko-KR': { currentWorld: '현재 세계:', switchWorld: '세계 전환', history: '메시지 기록', startChat: '역할과 대화 시작', startChatHint: '기록은 현재 세계에 보관되며 메시지를 보내면 역할이 작업을 시작합니다.', composer: '{name}에게 메시지 보내기', approval: '승인 요청', worldSettings: '세계 설정', restoring: '로컬 세계 복원 중…' },
  'es-ES': { currentWorld: 'Mundo actual:', switchWorld: 'Cambiar de mundo', history: 'Historial de mensajes', startChat: 'Iniciar una conversación', startChatHint: 'El historial permanece en este mundo. El rol empieza a trabajar cuando envías un mensaje.', composer: 'Enviar mensaje a {name}', approval: 'Solicitar aprobación', worldSettings: 'Configuración del mundo', restoring: 'Restaurando mundos locales…' },
  'fr-FR': { currentWorld: 'Monde actuel :', switchWorld: 'Changer de monde', history: 'Historique des messages', startChat: 'Démarrer une conversation', startChatHint: 'L’historique reste dans ce monde. Le rôle commence à travailler après l’envoi du message.', composer: 'Envoyer un message à {name}', approval: 'Demander une approbation', worldSettings: 'Paramètres du monde', restoring: 'Restauration des mondes locaux…' },
  'de-DE': { currentWorld: 'Aktuelle Welt:', switchWorld: 'Welt wechseln', history: 'Nachrichtenverlauf', startChat: 'Unterhaltung beginnen', startChatHint: 'Der Verlauf bleibt in dieser Welt. Die Rolle beginnt nach dem Senden einer Nachricht.', composer: 'Nachricht an {name}', approval: 'Genehmigung anfordern', worldSettings: 'Welteinstellungen', restoring: 'Lokale Welten werden wiederhergestellt…' },
  'pt-BR': { currentWorld: 'Mundo atual:', switchWorld: 'Trocar de mundo', history: 'Histórico de mensagens', startChat: 'Iniciar uma conversa', startChatHint: 'O histórico permanece neste mundo. O papel começa a trabalhar após o envio da mensagem.', composer: 'Enviar mensagem para {name}', approval: 'Solicitar aprovação', worldSettings: 'Configurações do mundo', restoring: 'Restaurando mundos locais…' },
  'ru-RU': { currentWorld: 'Текущий мир:', switchWorld: 'Сменить мир', history: 'История сообщений', startChat: 'Начать разговор', startChatHint: 'История хранится в этом мире. Роль начнёт работу после отправки сообщения.', composer: 'Сообщение для {name}', approval: 'Запросить одобрение', worldSettings: 'Настройки мира', restoring: 'Восстановление локальных миров…' },
  'ar-SA': { currentWorld: 'العالم الحالي:', switchWorld: 'تبديل العالم', history: 'سجل الرسائل', startChat: 'بدء محادثة', startChatHint: 'يبقى السجل في هذا العالم، ويبدأ الدور العمل بعد إرسال رسالة.', composer: 'إرسال رسالة إلى {name}', approval: 'طلب الموافقة', worldSettings: 'إعدادات العالم', restoring: 'جارٍ استعادة العوالم المحلية…' },
  'hi-IN': { currentWorld: 'वर्तमान दुनिया:', switchWorld: 'दुनिया बदलें', history: 'संदेश इतिहास', startChat: 'बातचीत शुरू करें', startChatHint: 'इतिहास इसी दुनिया में रहता है। संदेश भेजने के बाद भूमिका काम शुरू करती है।', composer: '{name} को संदेश भेजें', approval: 'स्वीकृति माँगें', worldSettings: 'दुनिया की सेटिंग', restoring: 'स्थानीय दुनियाएँ बहाल हो रही हैं…' },
} as const satisfies Record<UiLocale, Record<string, string>>

for (const [locale, messages] of Object.entries(catalogs) as Array<[UiLocale, Record<string, string>]>) {
  registerMessages(locale, Object.fromEntries(Object.entries(messages).map(([key, value]) => [`workbench.${key}`, value])))
}

export const ALL_WORKBENCH_CATALOGS = catalogs
