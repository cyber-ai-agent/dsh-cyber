import { registerMessages } from '../../i18n/runtime.js'

const messages = {
  'modelHub.chat.worldContext': ['为世界「{name}」选择模型', '為世界「{name}」選擇模型', 'Choose a model for world “{name}”'],
  'modelHub.chat.employeeContext': ['为角色「{name}」选择模型', '為角色「{name}」選擇模型', 'Choose a model for character “{name}”'],
  'modelHub.chat.worldScope': ['用于该世界中继承世界设置的角色；已有单独设置的角色不变。', '用於該世界中繼承世界設定的角色；已有個別設定的角色不變。', 'Applies to characters inheriting this world’s settings. Character overrides stay in place.'],
  'modelHub.chat.employeeScope': ['仅用于「{world}」中的此角色。', '僅用於「{world}」中的此角色。', 'Applies only to this character in “{world}”.'],
  'modelHub.chat.return': ['返回对话', '返回對話', 'Return to chat'],
  'modelHub.chat.tab': ['用于此对话', '用於此對話', 'Use in this chat'],
  'modelHub.chat.choose': ['选择此对话要使用的模型', '選擇此對話要使用的模型', 'Choose a model for this chat'],
  'modelHub.chat.imported': ['模型已导入，请选择一个用于此对话', '模型已匯入，請選擇一個用於此對話', 'Models imported. Choose one for this chat.'],
  'modelHub.chat.unverified': ['模型目录只说明服务商列出了这些模型，尚未验证对话或工具调用能力。', '模型目錄只表示服務商列出了這些模型，尚未驗證對話或工具呼叫能力。', 'The provider lists these models. Chat and tool support have not been verified.'],
  'modelHub.chat.retryLoad': ['重新读取模型配置', '重新讀取模型設定', 'Reload model configuration'],
  'modelHub.chat.loading': ['正在读取模型配置…', '正在讀取模型設定…', 'Loading model configuration…'],
  'modelHub.chat.empty': ['还没有可选择的模型', '尚無可選擇的模型', 'No models to choose from yet'],
  'modelHub.chat.emptyHint': ['先保存服务商并导入模型，再选择此对话的使用范围。', '先儲存服務商並匯入模型，再選擇此對話的使用範圍。', 'Save a provider and import models, then apply your choice to this chat.'],
  'modelHub.chat.modelLabel': ['选择模型', '選擇模型', 'Choose a model'],
  'modelHub.chat.manage': ['编辑服务商或导入模型', '編輯服務商或匯入模型', 'Edit providers or import models'],
  'modelHub.chat.showAll': ['选择模型池中的其他模型', '選擇模型池中的其他模型', 'Choose another model from the pool'],
  'modelHub.chat.chooseHint': ['请先选择一个模型；返回对话不会自动发送消息。', '請先選擇一個模型；返回對話不會自動傳送訊息。', 'Choose a model first. Returning to chat does not send a message.'],
  'modelHub.chat.selected': ['已选「{name}」。保存后返回对话，由你发送消息。', '已選「{name}」。儲存後返回對話，由你傳送訊息。', 'Selected “{name}”. Save to return to chat, then send your message.'],
  'modelHub.chat.applying': ['正在保存此对话的选择…', '正在儲存此對話的選擇…', 'Saving this chat’s model…'],
  'modelHub.chat.applyWorld': ['用于当前世界并返回对话', '用於目前世界並返回對話', 'Apply to this world and return to chat'],
  'modelHub.chat.applyEmployee': ['用于当前角色并返回对话', '用於目前角色並返回對話', 'Apply to this character and return to chat'],
  'modelHub.chat.fetching': ['正在保存并获取模型…', '正在儲存並取得模型…', 'Saving and fetching models…'],
  'modelHub.chat.saveFetch': ['保存服务商并获取模型列表', '儲存服務商並取得模型清單', 'Save provider and fetch model list'],
} as const

for (const [index, locale] of (['zh-CN', 'zh-TW', 'en-US'] as const).entries()) {
  registerMessages(locale, Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, values[index]!])) )
}
