import type { UiLocale } from '@dsh-cyber/contracts'
import { defineLocaleCatalogs } from './catalog-parity.js'
import { registerMessages } from './runtime.js'

/**
 * Plugin Generator copy. Keys the plugin flow shares with the character flow
 * (step names, buttons, source-file errors) are read from the
 * `characterGenerator` catalog; only plugin-specific strings live here.
 *
 * zh-CN and en-US are translated. The remaining locales are declared as
 * `null` gaps and resolve through the en-US fallback until translated.
 */
const UNTRANSLATED = {
  title: null, subtitle: null, close: null, back: null, opening: null, stepPublish: null, sourceIntro: null, sourceHint: null, sourceLabel: null, sourcePlaceholder: null, sourceSafety: null, sourceEmpty: null, analyzeTitle: null, analyzeDescription: null, analyzeProgress: null, analysisReady: null, previewTitle: null, previewDescription: null, displayName: null, summary: null, transforms: null, transformsHint: null, transformTitle: null, trigger: null, triggerHint: null, description: null, instruction: null, instructionHint: null, mode: null, modePrepend: null, modeAppend: null, modeReplace: null, modePrependHint: null, modeAppendHint: null, modeReplaceHint: null, priority: null, priorityHint: null, addTransform: null, removeTransform: null, effectTitle: null, effectSample: null, effectYouType: null, effectReceives: null, transformsSummary: null, requiredName: null, requiredSummary: null, transformsEmpty: null, transformsTooMany: null, triggerInvalid: null, triggerDuplicate: null, triggerReserved: null, descriptionRequired: null, descriptionTooLong: null, instructionRequired: null, instructionTooLong: null, priorityInvalid: null, publishTitle: null, publishDescription: null, publishPackageHint: null, publishButton: null, published: null, catalogLoading: null, catalogError: null, discardTitle: null,
} as const

const catalogs = defineLocaleCatalogs({
  'zh-CN': {
    title: '自定义插件', subtitle: '把一段提示词配方整理成可审阅、可安装的插件包。', close: '关闭自定义插件', back: '返回插件市场', opening: '正在打开插件创建器…',
    stepPublish: '发布插件',
    sourceIntro: '从一段提示词配方开始', sourceHint: '描述你想要的会话指令：什么时候输入、助手应该怎么做、输出什么结构。支持 Markdown 或纯文本。',
    sourceLabel: '提示词配方', sourcePlaceholder: '例如：输入 /weekly-review 时，只依据当前会话的事实，按进展、阻碍、下周计划三段整理本周复盘。',
    sourceSafety: '来源内容是不可信数据。分析结果需要你逐条检查后才会生成插件包。', sourceEmpty: '请先输入提示词配方。',
    analyzeTitle: '正在整理指令', analyzeDescription: '分析只会生成临时草稿，原文会保留在当前流程中。', analyzeProgress: '正在读取来源并整理触发词与指令…',
    analysisReady: '分析完成。请继续检查并编辑插件草稿。',
    previewTitle: '检查插件草稿', previewDescription: '每条指令都可以修改。插件只包含触发词和一段纯文本指令，不含代码、网址、密钥或任何额外权限。',
    displayName: '插件名称', summary: '插件简介',
    transforms: '指令', transformsHint: '每条指令绑定一个 / 开头的触发词；在会话中输入触发词时，宿主按所选模式把指令加进这条消息。',
    transformTitle: '第 {index} 条指令',
    trigger: '触发词', triggerHint: '以 / 开头，只含小写字母、数字和连字符。',
    description: '用途说明', instruction: '指令内容', instructionHint: '写给助手的纯文本指示，只作用于当前会话。',
    mode: '模式', modePrepend: '前置到消息前', modeAppend: '追加到消息后', modeReplace: '替换整条消息',
    modePrependHint: '指令放在你的消息之前。', modeAppendHint: '指令放在你的消息之后。', modeReplaceHint: '你的消息会被这段指令整个替换。',
    priority: '优先级', priorityHint: '多条指令同时命中时，数字大的先应用。',
    addTransform: '添加指令', removeTransform: '移除第 {index} 条指令',
    effectTitle: '效果预览', effectSample: '请整理本周的会话。', effectYouType: '你输入：', effectReceives: '角色实际收到：',
    transformsSummary: '{count} 条指令',
    requiredName: '请输入插件名称。', requiredSummary: '请输入插件简介。',
    transformsEmpty: '至少需要一条指令。', transformsTooMany: '指令数量超过上限。',
    triggerInvalid: '触发词必须以 / 开头，只包含小写字母、数字和连字符。', triggerDuplicate: '触发词不能重复。', triggerReserved: '触发词 {trigger} 已被官方插件「{owner}」使用，请换一个。',
    descriptionRequired: '请填写用途说明。', descriptionTooLong: '用途说明超过允许长度。', instructionRequired: '请填写指令内容。', instructionTooLong: '指令内容超过允许长度。', priorityInvalid: '优先级必须是整数。',
    publishTitle: '确认发布插件', publishDescription: '发布会生成一个本地插件包，并出现在插件市场中。', publishPackageHint: '发布不会自动安装插件。安装后在当前世界的会话中输入触发词即可使用。',
    publishButton: '发布到插件市场', published: '插件已发布',
    catalogLoading: '正在读取插件规则…', catalogError: '规则读取失败。仍可编辑指令，官方触发词冲突会在发布时检查。',
    discardTitle: '放弃未保存的插件草稿？',
  },
  'zh-TW': UNTRANSLATED,
  'en-US': {
    title: 'Custom plugin', subtitle: 'Turn a prompt recipe into a reviewable, installable plugin package.', close: 'Close custom plugin', back: 'Back to the plugin market', opening: 'Opening the plugin creator…',
    stepPublish: 'Publish plugin',
    sourceIntro: 'Start from a prompt recipe', sourceHint: 'Describe the chat commands you want: when to type them, what the assistant should do, what shape the output takes. Markdown or plain text.',
    sourceLabel: 'Prompt recipe', sourcePlaceholder: 'For example: when I type /weekly-review, summarize this week as progress, blockers and next steps, using only facts from the current conversation.',
    sourceSafety: 'The source is untrusted data. You review every command before a plugin package is generated.', sourceEmpty: 'Enter a prompt recipe first.',
    analyzeTitle: 'Composing the commands', analyzeDescription: 'Analysis only produces a temporary draft; the original text stays in this flow.', analyzeProgress: 'Reading the source and composing triggers and instructions…',
    analysisReady: 'Analysis complete. Continue to review and edit the plugin draft.',
    previewTitle: 'Review the plugin draft', previewDescription: 'Every command can be changed. A plugin is triggers plus plain-text instructions — never code, links, credentials or extra permissions.',
    displayName: 'Plugin name', summary: 'Plugin summary',
    transforms: 'Commands', transformsHint: 'Each command binds one slash trigger; when you type it in a conversation the host adds the instruction to that message in the chosen mode.',
    transformTitle: 'Command {index}',
    trigger: 'Trigger', triggerHint: 'Starts with / and uses only lowercase letters, digits and hyphens.',
    description: 'When to use it', instruction: 'Instruction', instructionHint: 'Plain-text directions for the assistant, scoped to the current conversation.',
    mode: 'Mode', modePrepend: 'Before the message', modeAppend: 'After the message', modeReplace: 'Replace the message',
    modePrependHint: 'The instruction goes before your message.', modeAppendHint: 'The instruction goes after your message.', modeReplaceHint: 'Your message is replaced by the instruction entirely.',
    priority: 'Priority', priorityHint: 'When several commands match, higher numbers apply first.',
    addTransform: 'Add a command', removeTransform: 'Remove command {index}',
    effectTitle: 'Effect preview', effectSample: 'Please summarize this week.', effectYouType: 'You type:', effectReceives: 'The character receives:',
    transformsSummary: '{count} commands',
    requiredName: 'Enter a plugin name.', requiredSummary: 'Enter a plugin summary.',
    transformsEmpty: 'At least one command is required.', transformsTooMany: 'Too many commands.',
    triggerInvalid: 'A trigger starts with / and uses only lowercase letters, digits and hyphens.', triggerDuplicate: 'Triggers must be unique.', triggerReserved: 'The trigger {trigger} belongs to the official plugin “{owner}”; choose another.',
    descriptionRequired: 'Say when to use the command.', descriptionTooLong: 'The description is too long.', instructionRequired: 'Enter the instruction.', instructionTooLong: 'The instruction is too long.', priorityInvalid: 'Priority must be an integer.',
    publishTitle: 'Confirm publishing the plugin', publishDescription: 'Publishing creates a local plugin package and lists it in the plugin market.', publishPackageHint: 'Publishing does not install the plugin. Once installed, type the trigger in a conversation of the current world to use it.',
    publishButton: 'Publish to the plugin market', published: 'Plugin published',
    catalogLoading: 'Loading the plugin rules…', catalogError: 'The rules could not be read. You can still edit commands; official trigger conflicts are checked at publish.',
    discardTitle: 'Discard the unsaved plugin draft?',
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
  registerMessages(locale, Object.fromEntries(Object.entries(messages).map(([key, value]) => [`pluginGenerator.${key}`, value])))
}

export const ALL_PLUGIN_GENERATOR_CATALOGS = catalogs
