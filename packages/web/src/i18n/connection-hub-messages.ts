import type { UiLocale } from '@dsh-cyber/contracts'

import { registerMessages } from './runtime.js'

const LOCALES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR', 'de-DE', 'pt-BR', 'ru-RU', 'ar-SA', 'hi-IN'] as const satisfies readonly UiLocale[]
type V = readonly [string, string, string, string, string, string, string, string, string, string, string, string]

const messages = {
  'app.connectionHub': ['连接中心', '連接中心', 'Connection hub', '接続センター', '연결 허브', 'Centro de conexiones', 'Centre de connexions', 'Verbindungszentrum', 'Central de conexões', 'Центр подключений', 'مركز الاتصالات', 'कनेक्शन केंद्र'],
  'connectionHub.title': ['连接中心', '連接中心', 'Connection Hub', '接続センター', '연결 허브', 'Centro de conexiones', 'Centre de connexions', 'Verbindungszentrum', 'Central de conexões', 'Центр подключений', 'مركز الاتصالات', 'कनेक्शन केंद्र'],
  'connectionHub.subtitle': ['统一管理受信任的连接：SSH 设备、API 端点等。凭据只在本机加密保存；角色仍需授权并逐动作审批。', '統一管理受信任的連線：SSH 裝置、API 端點等。憑證只在本機加密保存；角色仍需授權並逐動作審批。', 'Manage trusted connections: SSH devices, API endpoints and more. Credentials stay encrypted on this machine; characters still need grants and per-action approval.', 'SSH 機器や API エンドポイントなどの信頼済み接続を一元管理します。資格情報はこのマシンに暗号化して保存され、キャラクターには許可とアクションごとの承認が必要です。', '신뢰하는 연결(SSH 장치, API 엔드포인트 등)을 관리합니다. 자격 증명은 이 기기에 암호화되어 저장되며, 캐릭터는 권한과 개별 승인이 필요합니다.', 'Administre conexiones de confianza: dispositivos SSH, endpoints de API y más. Las credenciales quedan cifradas en este equipo; los personajes aún necesitan permisos y aprobación por acción.', 'Gérez les connexions de confiance : appareils SSH, points de terminaison API… Les identifiants restent chiffrés sur cette machine ; les personnages ont toujours besoin d’autorisations et d’une validation action par action.', 'Verwalten Sie vertrauenswürdige Verbindungen: SSH-Geräte, API-Endpunkte u. v. m. Zugangsdaten bleiben auf diesem Rechner verschlüsselt; Charaktere benötigen weiterhin Freigaben und Genehmigung pro Aktion.', 'Gerencie conexões confiáveis: dispositivos SSH, endpoints de API e mais. As credenciais ficam criptografadas nesta máquina; personagens ainda precisam de permissões e aprovação por ação.', 'Управление доверенными подключениями: SSH-устройства, API-эндпоинты и др. Учётные данные шифруются на этой машине; персонажи по-прежнему требуют прав и одобрения каждого действия.', 'إدارة الاتصالات الموثوقة: أجهزة SSH ونقاط نهاية API وغيرها. تُشفر البيانات سرًا على هذا الجهاز؛ ما زالت الشخصيات بحاجة إلى تفويض وموافقة لكل إجراء.', 'विश्वसनीय कनेक्शन प्रबंधित करें: SSH डिवाइस, API एंडपॉइंट आदि। क्रेडेंशियल इसी मशीन पर एन्क्रिप्ट रहते हैं; पात्रों को अनुदान और प्रति-क्रिया अनुमोदन चाहिए।'],
  'connectionHub.close': ['关闭连接中心', '關閉連接中心', 'Close connection hub', '接続センターを閉じる', '연결 허브 닫기', 'Cerrar el centro', 'Fermer le centre', 'Verbindungszentrum schließen', 'Fechar a central', 'Закрыть центр', 'إغلاق المركز', 'केंद्र बंद करें'],
  'connectionHub.loading': ['加载连接中心…', '載入連接中心…', 'Loading connection hub…', '接続センターを読み込み中…', '연결 허브 불러오는 중…', 'Cargando el centro…', 'Chargement du centre…', 'Verbindungszentrum wird geladen…', 'Carregando a central…', 'Загрузка центра…', 'جارٍ تحميل المركز…', 'केंद्र लोड हो रहा है…'],
} satisfies Record<string, V>

export const ALL_CONNECTION_HUB_CATALOGS = Object.fromEntries(LOCALES.map((locale, index) => [locale, Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, values[index]!]))])) as Record<UiLocale, Record<keyof typeof messages, string>>

for (const locale of LOCALES) registerMessages(locale, ALL_CONNECTION_HUB_CATALOGS[locale])
