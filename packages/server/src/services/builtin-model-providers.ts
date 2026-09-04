import type { ModelProviderCatalog } from '@dsh-cyber/contracts'

/**
 * The catalog bundled in this build — the level-3 fallback when no remote
 * copy or cached copy is available, and the seed for the repository file
 * `catalog/model-providers.json` that hosts the remote copy. A test asserts
 * the two never drift. Custom/LAN gateways are not entries here: the hub
 * offers "自定义" and "本地" as first-class creation flows instead.
 */
export const BUNDLED_MODEL_PROVIDER_CATALOG = {
  schemaVersion: 1,
  version: '2026.09.03-1',
  providers: [
    {
      id: 'deepseek', name: 'DeepSeek', badge: '官方',
      description: 'DeepSeek 官方文本与推理模型服务。',
      signup: { text: '前往 DeepSeek 开放平台注册并创建 API Key，粘贴到下方即可。', url: 'https://platform.deepseek.com/api_keys' },
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions', providerKind: 'deepseek', credentialMode: 'api-key',
      modelPlaceholder: 'deepseek-chat',
      popularModels: ['deepseek-chat', 'deepseek-reasoner'],
      defaults: { contextWindow: 64_000, maxTokens: 8_192, webSearchBaseUrl: 'https://api.deepseek.com/anthropic/v1' },
      balance: 'deepseek',
    },
    {
      id: 'agnes', name: 'Agnes AI', badge: '多模态',
      description: '兼容 OpenAI 接口的文本、图像、视频与多模态模型服务。',
      signup: { text: '在 Agnes AI 控制台注册后生成 API Key。', url: 'https://beta.agnes-ai.com/' },
      baseUrl: 'https://apihub.agnes-ai.com/v1',
      api: 'openai-completions', providerKind: 'openai-compatible-remote', credentialMode: 'api-key',
      modelPlaceholder: 'Agnes-2.5-Pro-Beta',
      popularModels: ['Agnes-2.5-Pro-Beta'],
    },
    {
      id: 'siliconflow', name: 'SiliconFlow', badge: '聚合',
      description: '聚合多家开源模型，提供 OpenAI 兼容接口。',
      signup: { text: '登录硅基流动控制台，在“API 密钥”页创建 Key。', url: 'https://cloud.siliconflow.cn/account/ak' },
      baseUrl: 'https://api.siliconflow.cn/v1',
      api: 'openai-completions', providerKind: 'openai-compatible-remote', credentialMode: 'api-key',
      modelPlaceholder: 'deepseek-ai/DeepSeek-V3',
      popularModels: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'],
    },
    {
      id: 'zhipu', name: 'Zhipu AI (GLM)', badge: '国内',
      description: '智谱官方 GLM 系列模型服务。',
      signup: { text: '登录智谱开放平台，在用户中心创建 API Key。', url: 'https://open.bigmodel.cn/usercenter/apikeys' },
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      api: 'openai-completions', providerKind: 'openai-compatible-remote', credentialMode: 'api-key',
      modelPlaceholder: 'glm-4-flash',
      popularModels: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'],
    },
    {
      id: 'moonshot', name: 'Moonshot (Kimi)',
      description: 'Moonshot 官方 Kimi 长上下文模型服务。',
      signup: { text: '登录 Moonshot 开放平台，在 API Keys 页面创建密钥。', url: 'https://platform.moonshot.cn/console/api-keys' },
      baseUrl: 'https://api.moonshot.cn/v1',
      api: 'openai-completions', providerKind: 'openai-compatible-remote', credentialMode: 'api-key',
      modelPlaceholder: 'moonshot-v1-8k',
      popularModels: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    },
    {
      id: 'openai', name: 'OpenAI',
      description: 'OpenAI 官方 GPT 与推理模型服务。',
      signup: { text: '在 OpenAI 平台账号下创建 API Key。', url: 'https://platform.openai.com/api-keys' },
      baseUrl: 'https://api.openai.com/v1',
      api: 'openai-responses', providerKind: 'openai-compatible-remote', credentialMode: 'api-key',
      modelPlaceholder: 'gpt-4o',
      popularModels: ['gpt-4o', 'gpt-4o-mini', 'o1-mini'],
    },
    {
      id: 'anthropic', name: 'Anthropic (Claude)',
      description: 'Anthropic 官方 Claude 模型服务。',
      signup: { text: '在 Anthropic 控制台创建 API Key。', url: 'https://console.anthropic.com/settings/keys' },
      baseUrl: 'https://api.anthropic.com/v1',
      api: 'anthropic-messages', providerKind: 'openai-compatible-remote', credentialMode: 'api-key',
      modelPlaceholder: 'claude-3-7-sonnet-latest',
      popularModels: ['claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
    },
    {
      id: 'gemini', name: 'Google Gemini',
      description: 'Google Gemini 多模态模型的 OpenAI 兼容接口。',
      signup: { text: '在 Google AI Studio 免费申请 API Key。', url: 'https://aistudio.google.com/apikey' },
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      api: 'openai-completions', providerKind: 'openai-compatible-remote', credentialMode: 'api-key',
      modelPlaceholder: 'gemini-2.5-pro',
      popularModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    },
    {
      id: 'openrouter', name: 'OpenRouter', badge: '聚合网关',
      description: '通过一个 OpenAI 兼容接口访问多家模型供应商。',
      signup: { text: '注册 OpenRouter 后在 Keys 设置页创建 API Key。', url: 'https://openrouter.ai/settings/keys' },
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openai-completions', providerKind: 'openai-compatible-remote', credentialMode: 'api-key',
      modelPlaceholder: 'deepseek/deepseek-chat',
      popularModels: ['deepseek/deepseek-chat', 'anthropic/claude-3.5-sonnet'],
      balance: 'openrouter',
    },
    {
      id: 'ollama', name: 'Ollama', badge: '本地免密',
      description: '在本机运行开源模型，无需账号和 API 密钥。',
      signup: { text: '安装 Ollama 并运行 `ollama pull <模型>` 后启动本地服务。', url: 'https://ollama.com/download' },
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions', providerKind: 'openai-compatible-local', credentialMode: 'none',
      modelPlaceholder: 'qwen2.5:7b',
      popularModels: ['qwen2.5:7b', 'deepseek-r1:8b', 'llama3.1:8b'],
    },
    {
      id: 'lm-studio', name: 'LM Studio', badge: '本地免密',
      description: '桌面端本地模型运行器，可启动 OpenAI 兼容服务。',
      signup: { text: '在 LM Studio 中下载模型并开启 Developer Local Server。', url: 'https://lmstudio.ai/download' },
      baseUrl: 'http://127.0.0.1:1234/v1',
      api: 'openai-completions', providerKind: 'openai-compatible-local', credentialMode: 'none',
      modelPlaceholder: 'local-model',
      popularModels: [],
    },
  ],
} satisfies ModelProviderCatalog
