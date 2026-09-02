import type { UiLocale } from '@dsh-cyber/contracts'
import { defineLocaleCatalogs } from './catalog-parity.js'
import { registerMessages } from './runtime.js'

/**
 * World Generator copy. Keys the world flow shares with the character flow
 * (step names, buttons, source-file errors, catalog choices) are read from the
 * `characterGenerator` catalog; only world-specific strings live here.
 *
 * zh-CN, zh-TW and en-US are translated. The remaining locales are declared
 * as `null` gaps and resolve through the en-US fallback until translated.
 */
const UNTRANSLATED = {
  title: null, subtitle: null, close: null, back: null, opening: null, stepPublish: null, sourceIntro: null, sourceHint: null, sourceLabel: null, sourcePlaceholder: null, sourceSafety: null, sourceEmpty: null, analyzeTitle: null, analyzeDescription: null, analyzeProgress: null, analysisReady: null, previewTitle: null, previewDescription: null, displayName: null, summary: null, terminology: null, terminologyHint: null, termWorld: null, termParticipant: null, termSession: null, termMilestone: null, workflow: null, workflowHint: null, workflowPlaceholder: null, rules: null, rulesHint: null, rulesPlaceholder: null, cast: null, castHint: null, noCast: null, castUnnamed: null, addCast: null, removeCast: null, baseTemplate: null, baseTemplateHint: null, sceneTitle: null, sceneNone: null, sceneHint: null, scenePick: null, sceneEmpty: null, requiredName: null, requiredSummary: null, requiredTerminology: null, castTooLarge: null, castDuplicate: null, castRequiredName: null, castRequiredRole: null, castRequiredSummary: null, castRequiredPersona: null, publishTitle: null, publishDescription: null, publishPackageHint: null, publishButton: null, published: null, none: null, countRules: null, catalogLoading: null, catalogError: null, discardTitle: null,
} as const

const catalogs = defineLocaleCatalogs({
  'zh-CN': {
    title: '自定义世界', subtitle: '把一段场景描述整理成可审阅、可安装的世界主题包。', close: '关闭自定义世界', back: '返回世界市场', opening: '正在打开世界创建器…',
    stepPublish: '发布世界',
    sourceIntro: '从一段场景描述开始', sourceHint: '描述你需要的场景：它是什么地方、谁在里面、按什么流程工作、有哪些规矩。支持 Markdown 或纯文本。',
    sourceLabel: '世界描述', sourcePlaceholder: '例如：一家社区法律援助诊所，律师、助理和志愿者分工接待来访者、梳理问题、准备材料并转介。',
    sourceSafety: '来源内容是不可信数据。分析结果需要你逐项检查后才会生成世界主题包。', sourceEmpty: '请先输入世界描述。',
    analyzeTitle: '正在整理世界设定', analyzeDescription: '分析只会生成临时草稿，原文会保留在当前流程中。', analyzeProgress: '正在读取来源并整理术语、流程、规则与默认角色…',
    analysisReady: '分析完成。请继续检查并编辑世界草稿。',
    previewTitle: '检查世界草稿', previewDescription: '所有字段都可以修改。默认角色的技能和能力只是请求，招募时仍需单独审阅。',
    displayName: '世界名称', summary: '世界简介', terminology: '世界术语', terminologyHint: '这些称谓会出现在世界界面里，替换默认的“世界 / 角色 / 会话 / 事迹”。',
    termWorld: '世界称谓', termParticipant: '参与者称谓', termSession: '会话称谓', termMilestone: '事迹称谓',
    workflow: '工作流程', workflowHint: '按顺序列出这个世界的工作环节。', workflowPlaceholder: '输入环节名称后按回车添加',
    rules: '世界规则', rulesHint: '每条规则一句话，所有角色都要遵守。', rulesPlaceholder: '输入规则后按回车添加',
    cast: '默认角色', castHint: '每名角色都会作为独立的角色模板发布，安装后再招募到世界。', noCast: '还没有默认角色。', castUnnamed: '未命名角色', addCast: '添加角色', removeCast: '移除这名角色',
    baseTemplate: '基础模板', baseTemplateHint: '生成的世界基于“我的世界”模板，安装后可从中创建独立的新世界。',
    sceneTitle: '默认 2D 场景', sceneNone: '尚未选择场景', sceneHint: '从官方场景中挑选一个作为世界的默认布局；上传自定义背景将在后续版本提供。', scenePick: '选择一个官方场景', sceneEmpty: '官方场景目录为空。',
    requiredName: '请输入世界名称。', requiredSummary: '请输入世界简介。', requiredTerminology: '请填写全部四个世界术语。', castTooLarge: '默认角色不能超过 8 名。', castDuplicate: '默认角色的名字不能重复。',
    castRequiredName: '每名默认角色都需要名字。', castRequiredRole: '每名默认角色都需要岗位或身份。', castRequiredSummary: '每名默认角色都需要简介。', castRequiredPersona: '每名默认角色都需要 Persona 与行为方式。',
    publishTitle: '确认发布世界主题', publishDescription: '发布会生成一个本地世界主题包和对应的角色模板包，并出现在世界市场与角色市场中。', publishPackageHint: '发布不会自动安装、创建世界或招募角色。',
    publishButton: '发布到世界市场', published: '世界主题已发布', none: '无', countRules: '{count} 条',
    catalogLoading: '正在读取官方场景与可用目录…', catalogError: '目录读取失败。仍可编辑世界资料，场景、技能和能力会在目录恢复后显示。',
    discardTitle: '放弃未保存的世界草稿？',
  },
  'zh-TW': {
    title: '自訂世界', subtitle: '將一段場景描述整理成可審閱、可安裝的世界主題套件。', close: '關閉自訂世界', back: '返回世界市場', opening: '正在開啟世界建立器…',
    stepPublish: '發布世界',
    sourceIntro: '從一段場景描述開始', sourceHint: '描述你需要的場景：它是什麼地方、誰在裡面、按什麼流程工作、有哪些規矩。支援 Markdown 或純文字。',
    sourceLabel: '世界描述', sourcePlaceholder: '例如：一家社區法律援助診所，律師、助理和志工分工接待來訪者、梳理問題、準備材料並轉介。',
    sourceSafety: '來源內容是不可信資料。分析結果需要你逐項檢查後才會產生世界主題套件。', sourceEmpty: '請先輸入世界描述。',
    analyzeTitle: '正在整理世界設定', analyzeDescription: '分析只會產生暫時草稿，原文會保留在目前流程中。', analyzeProgress: '正在讀取來源並整理術語、流程、規則與預設角色…',
    analysisReady: '分析完成。請繼續檢查並編輯世界草稿。',
    previewTitle: '檢查世界草稿', previewDescription: '所有欄位都可以修改。預設角色的技能和能力只是請求，招募時仍需另行審閱。',
    displayName: '世界名稱', summary: '世界簡介', terminology: '世界術語', terminologyHint: '這些稱謂會出現在世界介面裡，取代預設的「世界 / 角色 / 會話 / 事蹟」。',
    termWorld: '世界稱謂', termParticipant: '參與者稱謂', termSession: '會話稱謂', termMilestone: '事蹟稱謂',
    workflow: '工作流程', workflowHint: '依序列出這個世界的工作環節。', workflowPlaceholder: '輸入環節名稱後按 Enter 新增',
    rules: '世界規則', rulesHint: '每條規則一句話，所有角色都要遵守。', rulesPlaceholder: '輸入規則後按 Enter 新增',
    cast: '預設角色', castHint: '每名角色都會作為獨立的角色範本發布，安裝後再招募到世界。', noCast: '還沒有預設角色。', castUnnamed: '未命名角色', addCast: '新增角色', removeCast: '移除這名角色',
    baseTemplate: '基礎範本', baseTemplateHint: '產生的世界基於「我的世界」範本，安裝後可從中建立獨立的新世界。',
    sceneTitle: '預設 2D 場景', sceneNone: '尚未選擇場景', sceneHint: '從官方場景中挑選一個作為世界的預設佈局；上傳自訂背景將在後續版本提供。', scenePick: '選擇一個官方場景', sceneEmpty: '官方場景目錄為空。',
    requiredName: '請輸入世界名稱。', requiredSummary: '請輸入世界簡介。', requiredTerminology: '請填寫全部四個世界術語。', castTooLarge: '預設角色不能超過 8 名。', castDuplicate: '預設角色的名字不能重複。',
    castRequiredName: '每名預設角色都需要名字。', castRequiredRole: '每名預設角色都需要職位或身分。', castRequiredSummary: '每名預設角色都需要簡介。', castRequiredPersona: '每名預設角色都需要 Persona 與行為方式。',
    publishTitle: '確認發布世界主題', publishDescription: '發布會產生一個本機世界主題套件和對應的角色範本套件，並出現在世界市場與角色市場中。', publishPackageHint: '發布不會自動安裝、建立世界或招募角色。',
    publishButton: '發布到世界市場', published: '世界主題已發布', none: '無', countRules: '{count} 條',
    catalogLoading: '正在讀取官方場景與可用目錄…', catalogError: '目錄讀取失敗。仍可編輯世界資料，場景、技能和能力會在目錄恢復後顯示。',
    discardTitle: '放棄未儲存的世界草稿？',
  },
  'en-US': {
    title: 'Custom World', subtitle: 'Turn a scenario description into a reviewable, installable world theme package.', close: 'Close custom world', back: 'Back to the world market', opening: 'Opening the world builder…',
    stepPublish: 'Publish',
    sourceIntro: 'Start from a scenario description', sourceHint: 'Describe the place, who works there, the loop they follow and the rules they keep. Markdown or plain text.',
    sourceLabel: 'World description', sourcePlaceholder: 'e.g. A community legal aid clinic where lawyers, assistants and volunteers intake visitors, sort their issues, prepare documents and refer them on.',
    sourceSafety: 'The source is untrusted data. Review every result before a theme package is produced.', sourceEmpty: 'Enter a world description first.',
    analyzeTitle: 'Organizing the world setup', analyzeDescription: 'Analysis only produces a temporary draft. The original stays in this flow.', analyzeProgress: 'Reading the source and drafting terminology, workflow, rules and a default cast…',
    analysisReady: 'Analysis complete. Review and edit the world draft.',
    previewTitle: 'Review the world draft', previewDescription: 'Every field is editable. Cast skills and capabilities are requests, reviewed again at recruitment.',
    displayName: 'World name', summary: 'World summary', terminology: 'World terminology', terminologyHint: 'These nouns replace the default “world / participant / session / milestone” in the world UI.',
    termWorld: 'Word for the world', termParticipant: 'Word for a participant', termSession: 'Word for a session', termMilestone: 'Word for a milestone',
    workflow: 'Workflow', workflowHint: 'List the working steps of this world in order.', workflowPlaceholder: 'Type a step and press Enter',
    rules: 'World rules', rulesHint: 'One sentence per rule; every character follows them.', rulesPlaceholder: 'Type a rule and press Enter',
    cast: 'Default cast', castHint: 'Each member is published as its own character template, installed and then recruited.', noCast: 'No default cast yet.', castUnnamed: 'Unnamed character', addCast: 'Add character', removeCast: 'Remove this character',
    baseTemplate: 'Base template', baseTemplateHint: 'Generated worlds are based on the “My World” template; install the theme to create independent worlds from it.',
    sceneTitle: 'Default 2D scene', sceneNone: 'No scene selected', sceneHint: 'Pick an official scene as the default layout; uploading a custom background is a later release.', scenePick: 'Pick an official scene', sceneEmpty: 'The official scene catalog is empty.',
    requiredName: 'Enter a world name.', requiredSummary: 'Enter a world summary.', requiredTerminology: 'Fill in all four terminology slots.', castTooLarge: 'A default cast holds at most 8 characters.', castDuplicate: 'Cast member names must be unique.',
    castRequiredName: 'Every cast member needs a name.', castRequiredRole: 'Every cast member needs a role.', castRequiredSummary: 'Every cast member needs a summary.', castRequiredPersona: 'Every cast member needs a persona.',
    publishTitle: 'Confirm world theme publish', publishDescription: 'Publishing produces a local world theme package plus one character template package per cast member, listed in the world and character markets.', publishPackageHint: 'Publishing does not install, create a world or recruit anyone.',
    publishButton: 'Publish to the world market', published: 'World theme published', none: 'None', countRules: '{count}',
    catalogLoading: 'Loading official scenes and the available catalog…', catalogError: 'Catalog unavailable. World details are still editable; scenes, skills and capabilities appear once it recovers.',
    discardTitle: 'Discard the unsaved world draft?',
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
  registerMessages(locale, Object.fromEntries(Object.entries(messages).map(([key, value]) => [`worldGenerator.${key}`, value])))
}

export const ALL_WORLD_GENERATOR_CATALOGS = catalogs
