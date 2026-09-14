# 联网搜索 Bridge V1

连接中心新增「联网搜索」主项，用于管理角色内置 `web_search` 模型工具所使用的搜索服务商。它解决的核心体验问题：此前模型工具 `web_search` 恒走 DSH 内置 `web-search-deepseek` 提供方，而该提供方默认读取 `DEEPSEEK_API_KEY`（DSH Cyber 从不导出该变量，密钥在独立加密 vault 中以生成名注入），导致只要用户没有逐档案勾选“启用联网搜索”，对话中每次联网搜索都会以“缺 DEEPSEEK_API_KEY”的原始错误失败——即使工作区明明配置了可用的搜索服务商。

## 产品位置

- 连接中心左栏由 `IntegrationDescriptor[]` 驱动；`builtin.web-search`（显示名「联网搜索」）是**常驻主项**。
- **接管旧 Firecrawl**：旧的独立「Firecrawl」主项不再出现在左栏（`visibleDescriptors` 恒定过滤 `builtin.firecrawl`）。它的设置入口就是「联网搜索」里的 Firecrawl 卡片，**凭据仍存放在原 `builtin.firecrawl` 连接**，因此角色技能 `web.search.firecrawl`、知识库网页导入、连接测试等既有链路零迁移继续可用。市场里插件面板的「打开 Firecrawl 设置」也会预选到「联网搜索」。
- **服务商是固定卡片，不是下拉框**：卡片来自仓库内的 `catalog/web-search-providers.json`；每张卡片平铺展示**搜索服务商 / 服务地址 / 服务说明 / 获取途径地址**。
- **编辑只做两件事**：填 API 密钥、确认「设为默认搜索服务商」。列表上给默认项加「默认」徽标；已配置的卡片显示「密钥已配置」，可「清除密钥」。
- 服务商目录 JSON 是唯一扩展点：新增一家 = 加一条 JSON 条目（`id/name/endpoint/description/obtain/backend`，需要时加 `integrationId` 指定凭据落在哪个集成类型）＋ 对应的 worker 侧驱动。

## 服务商目录（仓库 JSON）

```jsonc
// catalog/web-search-providers.json
{ "schemaVersion": 1, "version": "2026.09.10-1",
  "providers": [
    { "id": "deepseek", "name": "DeepSeek", "endpoint": "https://api.deepseek.com/anthropic/v1",
      "description": "…", "obtain": { "text": "…", "url": "https://platform.deepseek.com/api_keys" },
      "backend": "deepseek" },
    { "id": "firecrawl", "name": "Firecrawl", "endpoint": "https://api.firecrawl.dev",
      "description": "…", "obtain": { "text": "…", "url": "https://www.firecrawl.dev/app/sign-up" },
      "backend": "firecrawl", "integrationId": "builtin.firecrawl" }
  ] }
```

- 服务端通过 `GET /api/integrations/web-search/providers` 把该目录交给 UI，卡片据此渲染（服务地址固定，用户不可改）。
- 路径沿用模型目录惯例：`packages/server/lib` 向上三级定位仓库内文件；`DSH_CYBER_WEBSEARCH_CATALOG_PATH` 可指向别的文件，设为空串则禁用仓库来源并回落到内置目录。文件缺失或结构非法时同样回落（内置目录只保 DeepSeek + Firecrawl）。
- 没有 `integrationId` 的条目按其密钥落在 `builtin.web-search`（每条目一条连接，`config.provider` 留痕）；带 `integrationId` 的条目（Firecrawl）复用既有集成类型。

## 运行时机制（驱动 DSH `web` 缝）

DSH 的 `web` 缝本就是“多提供方注册 + 显式选择”（`ctx.web.registerSearchProvider` + `web.searchProvider`）。本特性在三个层面接入：

1. **DeepSeek 后端**：复用 DSH 内置 `web-search-deepseek` 提供方（id `deepseek-official`）。worker profile 写 `web-search-deepseek: { apiKeyEnv, baseURL }`（`baseURL` 取目录里的服务地址），并把密钥经**生成名 env**（`DSH_CYBER_WEBSEARCH_DEEPSEEK_KEY`）注入 worker 启动环境（与模型密钥同一信任边界）。
2. **Firecrawl 后端**：在 `@dsh-cyber/harness-bundle` 注册一个 `firecrawl` 搜索提供方。它**不持有凭据**：worker 仅被注入回环坐标（`DSH_CYBER_LOOPBACK_ORIGIN` / `DSH_CYBER_WORKER_TOKEN` / `DSH_CYBER_WORKSPACE_ID`），实际搜索经 loopback 调宿主路由 `POST /api/integrations/firecrawl/search`（每次启动随机 token 鉴权），由宿主侧 `firecrawlSearchDirect` 用 Firecrawl 连接的密钥执行——**密钥从不进入 worker**。
3. **无可用后端**：写 `tool-web: { search: false }`，模型**看不到** `web_search` 工具，角色只会明说“没有搜索能力”，不再每次弹密钥缺失。

### 选择与优先级

候选 = 启用的 `builtin.web-search` 连接 ＋ 接管来的旧 `builtin.firecrawl` 连接。选中顺序：**勾选默认的那条** > **第一条已配置密钥的** > 第一条；一条候选都没有则不注册工具。

整体优先级：模型档案级“启用联网搜索”（`route.webSearch`，模型中心那个勾选）> 连接中心「联网搜索」选中的服务商 > 隐藏工具。

默认唯一性由服务端在保存时归一：任一类型（联网搜索或旧 Firecrawl）被标为默认，会清掉同一工作区其它联网搜索连接的默认标记，以及旧 Firecrawl 连接的默认标记。

## 安全边界

- worker 回环路由在 `application-access` 公共路径集中：鉴权靠**每次启动随机、不落盘**的 worker token（一个能力而非用户凭据），应用锁期间不存在活动回合、也就没有 worker 调用它。
- Firecrawl / DeepSeek 密钥始终留在宿主 `stateRoot/integrations` 加密凭据库（或 vault）；worker 只拿到回环坐标或生成名环境变量。
- 取消旧 Firecrawl 的“装了 recipe 才能配置”门控后，CRUD 不再要求安装插件；**技能可用性仍由插件包决定**（`web.search.firecrawl` 只在该 recipe 安装后由角色技能链提供）。
- 新增持久化仅复用既有 `stateRoot/integrations` 连接目录，未新增目录，不触及 Backup Bundle 边界。

## 代码落点

- `catalog/web-search-providers.json`：服务商目录（仓库内、可扩展）。
- `packages/contracts`：`WebSearchProviderDescriptor` / `WebSearchProviderCatalog` 类型；`WEB_SEARCH_WORKER_ENV` / `WEB_SEARCH_WORKER_TOKEN_HEADER`。
- `packages/server`：`web-search-catalog.ts`（目录加载/校验/回落）、`integrations/web-search-provider.ts`（`builtin.web-search`）、`integrations/firecrawl-provider.ts`（旧类型新增 `isDefault`）、`services/web-search-bridge.ts`（`activeWebSearch` + `resolveWebSearchPlan`）、`compose-web-search.ts`（token + 回环接线，保持 server.ts 在 600 行架构预算内）、`routes/web-search-routes.ts`（目录路由 + worker 回环路由）、`integrations/firecrawl-client.ts`（`firecrawlSearchDirect`）、`routes/integration-routes.ts`（隐藏旧主项、跨类型默认归一）、`http/application-access-guard.ts`（公共路径）。
- `packages/harness-adapter`：`web-search.ts`（`WorkerWebSearchPlan` + `applyWebSearchPlanToEnvironment`）、`profile.ts`（按 plan 写 patch 行）、`model-router.ts`（`resolveWebSearchPlan` 选项）、`adapter.ts`（worker env 注入 + 系统提示词引导指向连接中心）。
- `packages/harness-bundle`：`web-search-firecrawl.ts`（`firecrawl` 搜索提供方，注入 `web` 缝）。
- `packages/web`：`WebSearchProviderCards.tsx`（卡片工作区）、`IntegrationSettingsPanel.tsx`（联网搜索分支 + Firecrawl 技能预选映射）、`styles.css`（卡片样式 + 字段说明 12px）。

## 视觉验收记录（连接中心 · 联网搜索）

证据：`artifacts/web-search-hub/`（三视口截图 `web-search-hub-1440x900.png` / `web-search-hub-1920x1080.png` / `web-search-hub-3840x2160.png` + 机读审计 `web-search-hub-audit.json`，由 `e2e/web-search-hub.spec.ts` 自动生成）。

逐视口记录（三个视口结果一致）：

| 检查项 | 结果 |
| --- | --- |
| 图片/弹窗自适应 | 弹窗 `min(1180px, 96vw) × min(820px, 92vh)` 居中、未越出视口（`dialog.fits: true`），无黑边 |
| 大段空白 | 无：左侧类目栏 240px + 右侧卡片铺满，服务地址/说明/获取途径均完整入镜 |
| 文字对比度 | 全部可见正文最低 6.82:1（WCAG AA ≥4.5 通过），`lowContrastTexts` 为空 |
| 语言一致性 | 标题/按钮/说明全中文；`web_search`、`SSH`、`MCP`、`API`、`Streamable HTTP`、服务地址 URL 为协议/工具标识，仅出现在技术说明位置，符合护栏第 3 条 |
| 最小字号 | 12px（卡片说明与字段说明显式 12px，`.connection-hub .dialog-field small` 不再落到浏览器 `<small>` 默认 0.83em≈10.8px），`smallTexts` 为空 |
| 文案可读性 | 12–14px 正文 + 1.5 行高，服务地址 `overflow-wrap: anywhere` 不溢出 |
| 控制台 | 三视口 `console error/warn` 与 `pageerror` 均为 0（审计 `consoleIssues` 为空） |

## 已知限制 / 后续

- 服务地址按目录固定，卡片不提供自托管地址输入；需要自托管 Firecrawl 时仍可通过旧连接的 `baseUrl`（归档数据）沿用，UI 层后续再评估。
- 目录没有签名校验：它是随程序发布的仓库文件，改动需走代码评审；远端目录同步未纳入 v1。
- 默认标记归一发生在保存时；跨进程并发保存同一工作区两条默认连接的极端竞态未加锁（本地单用户场景可接受）。
- 后续可扩展：更多目录条目（含新的 `backend` 与 worker 侧驱动）、卡片内联“测试连接”入口、默认项排序置顶。
