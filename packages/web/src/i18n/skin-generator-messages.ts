import type { UiLocale } from '@dsh-cyber/contracts'
import { defineLocaleCatalogs } from './catalog-parity.js'
import { registerMessages } from './runtime.js'

/**
 * Skin Generator copy. Keys the skin flow shares with the character flow
 * (step names, buttons, source-file errors) are read from the
 * `characterGenerator` catalog; only skin-specific strings live here.
 *
 * zh-CN, zh-TW and en-US are translated. The remaining locales are declared
 * as `null` gaps and resolve through the en-US fallback until translated.
 */
const UNTRANSLATED = {
  title: null, subtitle: null, close: null, back: null, opening: null, stepPublish: null, sourceIntro: null, sourceHint: null, sourceLabel: null, sourcePlaceholder: null, sourceSafety: null, sourceEmpty: null, analyzeTitle: null, analyzeDescription: null, analyzeProgress: null, analysisReady: null, previewTitle: null, previewDescription: null, displayName: null, summary: null, palette: null, paletteHint: null, accentColor: null, pageBackground: null, panelBackground: null, textColor: null, ownerBubbleColor: null, characterBubbleColor: null, backdropOpacity: null, backdropTitle: null, backdropNone: null, backdropHint: null, backdropPick: null, backdropEmpty: null, livePreview: null, livePreviewHint: null, previewOwner: null, previewCharacter: null, previewAction: null, requiredName: null, requiredSummary: null, colorInvalid: null, opacityInvalid: null, publishTitle: null, publishDescription: null, publishPackageHint: null, publishButton: null, published: null, catalogLoading: null, catalogError: null, discardTitle: null, colorsSummary: null,
} as const

const catalogs = defineLocaleCatalogs({
  'zh-CN': {
    title: '自定义皮肤', subtitle: '把一段风格描述整理成可审阅、可安装的皮肤包。', close: '关闭自定义皮肤', back: '返回皮肤市场', opening: '正在打开皮肤创建器…',
    stepPublish: '发布皮肤',
    sourceIntro: '从一段风格描述开始', sourceHint: '描述你想要的氛围：整体色调、面板质感、气泡的冷暖、文字的明暗。支持 Markdown 或纯文本。',
    sourceLabel: '皮肤描述', sourcePlaceholder: '例如：一间安静的深夜图书馆，深蓝底色、暖黄阅读灯、木质书架的沉稳感。',
    sourceSafety: '来源内容是不可信数据。分析结果需要你逐项检查后才会生成皮肤包。', sourceEmpty: '请先输入皮肤描述。',
    analyzeTitle: '正在整理配色', analyzeDescription: '分析只会生成临时草稿，原文会保留在当前流程中。', analyzeProgress: '正在读取来源并整理配色与背景建议…',
    analysisReady: '分析完成。请继续检查并编辑皮肤草稿。',
    previewTitle: '检查皮肤草稿', previewDescription: '所有颜色都可以修改。皮肤只包含六种颜色、一个透明度和一个官方场景选择，不含任何样式代码。',
    displayName: '皮肤名称', summary: '皮肤简介',
    palette: '配色', paletteHint: '每个颜色都是一个 #rrggbb 十六进制值，其余视觉效果由宿主推导。',
    accentColor: '强调色', pageBackground: '页面背景', panelBackground: '面板背景', textColor: '文字颜色', ownerBubbleColor: '我的气泡', characterBubbleColor: '角色气泡',
    backdropOpacity: '背景透明度',
    backdropTitle: '会话背景', backdropNone: '不使用背景图', backdropHint: '从官方皮肤中挑选一个场景作为聊天背景；上传自定义背景将在后续版本提供。', backdropPick: '选择一个官方背景', backdropEmpty: '官方背景目录为空。',
    livePreview: '实时预览', livePreviewHint: '只在这个预览里生效，不会改变当前界面。', previewOwner: '我：把今天的资料整理成时间线。', previewCharacter: '角色：已按时间排好，需要我标出时效吗？', previewAction: '发送',
    requiredName: '请输入皮肤名称。', requiredSummary: '请输入皮肤简介。', colorInvalid: '所有颜色都必须是 #rrggbb 形式。', opacityInvalid: '背景透明度必须在 0.2 到 1 之间。',
    publishTitle: '确认发布皮肤', publishDescription: '发布会生成一个本地皮肤包，并出现在皮肤市场中。', publishPackageHint: '发布不会自动安装或应用皮肤。',
    publishButton: '发布到皮肤市场', published: '皮肤已发布',
    catalogLoading: '正在读取官方背景目录…', catalogError: '目录读取失败。仍可编辑配色，官方背景会在目录恢复后显示。',
    discardTitle: '放弃未保存的皮肤草稿？', colorsSummary: '{count} 种颜色',
  },
  'zh-TW': {
    title: '自訂皮膚', subtitle: '把一段風格描述整理成可審閱、可安裝的皮膚包。', close: '關閉自訂皮膚', back: '返回皮膚市場', opening: '正在開啟皮膚建立器…',
    stepPublish: '發布皮膚',
    sourceIntro: '從一段風格描述開始', sourceHint: '描述你想要的氛圍：整體色調、面板質感、氣泡的冷暖、文字的明暗。支援 Markdown 或純文字。',
    sourceLabel: '皮膚描述', sourcePlaceholder: '例如：一間安靜的深夜圖書館，深藍底色、暖黃閱讀燈、木質書架的沉穩感。',
    sourceSafety: '來源內容是不可信資料。分析結果需要你逐項檢查後才會生成皮膚包。', sourceEmpty: '請先輸入皮膚描述。',
    analyzeTitle: '正在整理配色', analyzeDescription: '分析只會生成臨時草稿，原文會保留在目前流程中。', analyzeProgress: '正在讀取來源並整理配色與背景建議…',
    analysisReady: '分析完成。請繼續檢查並編輯皮膚草稿。',
    previewTitle: '檢查皮膚草稿', previewDescription: '所有顏色都可以修改。皮膚只包含六種顏色、一個透明度和一個官方場景選擇，不含任何樣式程式碼。',
    displayName: '皮膚名稱', summary: '皮膚簡介',
    palette: '配色', paletteHint: '每個顏色都是一個 #rrggbb 十六進位值，其餘視覺效果由宿主推導。',
    accentColor: '強調色', pageBackground: '頁面背景', panelBackground: '面板背景', textColor: '文字顏色', ownerBubbleColor: '我的氣泡', characterBubbleColor: '角色氣泡',
    backdropOpacity: '背景透明度',
    backdropTitle: '會話背景', backdropNone: '不使用背景圖', backdropHint: '從官方皮膚中挑選一個場景作為聊天背景；上傳自訂背景將在後續版本提供。', backdropPick: '選擇一個官方背景', backdropEmpty: '官方背景目錄為空。',
    livePreview: '即時預覽', livePreviewHint: '只在這個預覽裡生效，不會改變目前介面。', previewOwner: '我：把今天的資料整理成時間線。', previewCharacter: '角色：已按時間排好，需要我標出時效嗎？', previewAction: '傳送',
    requiredName: '請輸入皮膚名稱。', requiredSummary: '請輸入皮膚簡介。', colorInvalid: '所有顏色都必須是 #rrggbb 形式。', opacityInvalid: '背景透明度必須在 0.2 到 1 之間。',
    publishTitle: '確認發布皮膚', publishDescription: '發布會生成一個本機皮膚包，並出現在皮膚市場中。', publishPackageHint: '發布不會自動安裝或套用皮膚。',
    publishButton: '發布到皮膚市場', published: '皮膚已發布',
    catalogLoading: '正在讀取官方背景目錄…', catalogError: '目錄讀取失敗。仍可編輯配色，官方背景會在目錄恢復後顯示。',
    discardTitle: '放棄未儲存的皮膚草稿？', colorsSummary: '{count} 種顏色',
  },
  'en-US': {
    title: 'Custom skin', subtitle: 'Turn a style description into a reviewable, installable skin package.', close: 'Close custom skin', back: 'Back to the skin market', opening: 'Opening the skin creator…',
    stepPublish: 'Publish skin',
    sourceIntro: 'Start from a style description', sourceHint: 'Describe the mood you want: overall tone, panel texture, warm or cool bubbles, light or dark text. Markdown or plain text.',
    sourceLabel: 'Skin description', sourcePlaceholder: 'For example: a quiet late-night library — deep blue base, warm reading lamps, the calm of wooden shelves.',
    sourceSafety: 'The source is untrusted data. You review every value before a skin package is generated.', sourceEmpty: 'Enter a skin description first.',
    analyzeTitle: 'Composing the palette', analyzeDescription: 'Analysis only produces a temporary draft; the original text stays in this flow.', analyzeProgress: 'Reading the source and composing colours and a backdrop suggestion…',
    analysisReady: 'Analysis complete. Continue to review and edit the skin draft.',
    previewTitle: 'Review the skin draft', previewDescription: 'Every colour can be changed. A skin is six colours, one opacity and one official scene pick — never style code.',
    displayName: 'Skin name', summary: 'Skin summary',
    palette: 'Palette', paletteHint: 'Each colour is one #rrggbb hex value; the host derives every other visual token.',
    accentColor: 'Accent', pageBackground: 'Page background', panelBackground: 'Panel background', textColor: 'Text', ownerBubbleColor: 'My bubble', characterBubbleColor: 'Character bubble',
    backdropOpacity: 'Backdrop opacity',
    backdropTitle: 'Conversation backdrop', backdropNone: 'No backdrop image', backdropHint: 'Pick an official skin scene as the chat backdrop; uploading a custom backdrop is a follow-up.', backdropPick: 'Choose an official backdrop', backdropEmpty: 'The official backdrop catalog is empty.',
    livePreview: 'Live preview', livePreviewHint: 'Applies inside this preview only; the current interface is unchanged.', previewOwner: 'Me: turn today’s notes into a timeline.', previewCharacter: 'Character: sorted by time — shall I flag the deadlines?', previewAction: 'Send',
    requiredName: 'Enter a skin name.', requiredSummary: 'Enter a skin summary.', colorInvalid: 'Every colour must be a #rrggbb value.', opacityInvalid: 'Backdrop opacity must be between 0.2 and 1.',
    publishTitle: 'Confirm publishing the skin', publishDescription: 'Publishing creates a local skin package and lists it in the skin market.', publishPackageHint: 'Publishing does not install or apply the skin.',
    publishButton: 'Publish to the skin market', published: 'Skin published',
    catalogLoading: 'Loading the official backdrop catalog…', catalogError: 'The catalog could not be read. You can still edit the palette; official backdrops appear once it recovers.',
    discardTitle: 'Discard the unsaved skin draft?', colorsSummary: '{count} colours',
  },
  'ja-JP': UNTRANSLATED,
  'ko-KR': UNTRANSLATED,
  'es-ES': UNTRANSLATED,
  'fr-FR': UNTRANSLATED,
  'de-DE': UNTRANSLATED,
  'pt-BR': UNTRANSLATED,
  'ru-RU': UNTRANSLATED,
  'ar-SA': UNTRANSLATED,
  'hi-IN': UNTRANSLATED,
})

for (const [locale, messages] of Object.entries(catalogs) as Array<[UiLocale, Record<string, string>]>) {
  registerMessages(locale, Object.fromEntries(Object.entries(messages).map(([key, value]) => [`skinGenerator.${key}`, value])))
}

export const ALL_SKIN_GENERATOR_CATALOGS = catalogs
