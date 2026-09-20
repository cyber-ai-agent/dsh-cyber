# 工作台视觉返工与角色模型配置

## 已确认的方向

用户确认冷灰浅色概念稿，并要求保留明暗切换、从聊天中移除模型选择。模型按角色独立配置，入口保留在设置与模型中心。

视觉主张：白色阅读面、冷灰侧栏、少量青色强调；像素角色与世界场景保留产品身份。对话、输入、交付内容构成主工作区，世界采用独立视窗并支持全屏展开。

参考查看：[ZCode 官方页面](https://zcode.z.ai/en)、[Codex 官方界面资料](https://learn.chatgpt.com/docs/app)。参考其层级、灰阶和工具栏秩序。

概念稿由内置 ImageGen 生成，用户已确认。原图尺寸 1586×992，文件为：

`C:/Users/Administrator/.codex/generated_images/01a0bf8a-33fe-7421-b2f9-aee1241c92a5/exec-1b1e84b4-81d7-429c-8588-0ee577438e75.png`

概念 brief：完整工作台；会话侧栏、开放式角色回复、文件交付行、安静的排队提示、统一输入区、独立像素世界视窗；白／冷灰／青色；保留市场、创意工坊和世界／轨迹／更多的信息架构。用户后续确认从输入区移除模型选项。

## 基线与范围

- 分支 `codex/chat-visual-redesign`。
- `git fetch origin --prune` 后从 `origin/main` 建立分支，开始时 HEAD / origin/main / merge-base 均为 `ac09957df83773c97ef39da7b68cd497ab7e2810`。
- 上一批交互修复 `a59acec` 已带入本分支，对应 `552a152`。
- 测试使用临时目录下的独立 stateRoot。已有偏好行保持原值；默认亮色和 440px 侧栏适用于尚未保存偏好的工作区。

## 设计系统与实现

| 项目 | 亮色 | 暗色 |
|---|---|---|
| 阅读面 | `#ffffff` | `#1c2429` |
| 侧栏 | `#f4f6f7` | `#161e23` |
| 正文 | `#1f3038` | `#e1eaef` |
| 强调色 | `#087f83` | `#4eb7b9` |
| 边界 | `#e0e7ea` | `#2e3b43` |

正文 17px；辅助文字至少 12px。沿用本机微软雅黑与无衬线回退、现有 Phosphor 图标。输入区和消息列对齐，角色回复采用开放排版，用户消息使用轻背景。会话选中状态使用青色短线和浅底色。

- `styles-workbench.css` 管理默认工作台；原有命名皮肤装饰移动到 `skin-decorations.css`，选择皮肤时加载。
- `WorkbenchToolsMenu` 收纳皮肤、技能、模型、连接与系统状态入口。子组件持续挂载，配置弹窗使用既有 Portal。
- `ChatQueuePanel` 保留真实的编辑、优先处理、取消操作，放进可见省略号菜单。
- `ChatWorkbench` 移除模型选择及前端模型推断代码，保留复制、回复菜单与真实保存文档入口。
- 新聊天请求省略 modelProfileId / modelProfileIds，由宿主解析角色模型绑定。已有未确认回执继续按原请求核对，保持原提交 ID 的语义。
- 世界画布使用原有渲染器、场景和角色数据；新增原生全屏展开，继续由 ResizeObserver 调整画布。
- 偏好默认值采用亮色和较窄世界侧栏；已有明暗设置通过持久化回归验证保持原值。

## 与概念稿的对照

已用 `view_image` 同时检查概念稿及最新浏览器实页，包括原图尺寸 1586×992。

| 对照点 | 实页结果 |
|---|---|
| 配色 | 阅读面、导航、输入与 Dock 使用同一套冷灰／青色体系；暗色有完整对应色值 |
| 字体层级 | 正文、标题、角色名、时间与按钮分别设定字号和字重；控制文字沿用统一字体 |
| 顶部秩序 | 常用的市场与创意工坊直接可见，其余全局能力进入工具菜单 |
| 会话与回复 | 会话选中线、像素头像、开放式角色正文、轻背景用户消息保持概念方向 |
| 交付与输入 | 文档行展示实际保存结果并可打开；输入区保留附件、权限与语音等既有操作 |
| 场景与控件 | 像素场景留在独立边界内，工具条与外部界面共用色系，支持实际全屏进入与退出 |

明确调整：用户要求移除概念中的模型按钮；真实横向世界资产采用较宽的预览比例以保留角色；头像、时间、消息、角色数量和文件状态全部来自本地数据；空输入时发送按钮按真实状态禁用。像素角色与原有立方体品牌图标继续使用项目资产。

首屏文案核对：新增内容限于“工具”、世界展开、世界互动说明、队列菜单和文档状态。概念图中的示例日期与示例模型名由真实状态替代。

## 视觉与交互证据

证据目录：

`C:/Users/Administrator/.codex/visualizations/2026/09/20/01a0bf8a-33fe-7421-b2f9-aee1241c92a5/`

- `redesign-light-{尺寸}.png` / `redesign-dark-{尺寸}.png`
- 尺寸为 1440×900、1586×992、1920×1080、3840×2160、1100×760。
- `redesign-world-expanded.png`：真实全屏世界。
- `redesign-delivery.png`：真实保存文档的详情。
- `redesign-visual-qa.json`：字号、对比度、布局与画布尺寸、console 记录。

每档均检查：画布覆盖、布局空白、对比度、中文标签、最小字号与文案可读性。工作台水平溢出为 0；正文区最小字号 12px、父级有效透明度 1，最低对比度约 5.13:1。短会话在大屏保留阅读空间。统计中原生隐藏文件 input 的内部溢出属于文件选择实现，实际工作台宽度保持受控。

内置 IAB 初始化超时，浏览器验收使用 Playwright Chromium。全部操作通过真实可见控件进行。

已验证路径：私聊发送 → 每个角色保留各自模型绑定 → 工具菜单打开模型中心 → 修改指定角色的模型 → 新消息采用新绑定；保存回复 → 点击文档 → 产物详情；排队 → 优先处理 → 取消；展开世界 → 全景 → 退出；明暗切换及五种视口。

## 检查命令与结果

```powershell
pnpm run typecheck
pnpm run build
pnpm exec vitest run packages/web/tests/chat-control-ui.test.ts packages/web/tests/workbench-tools-and-queue.test.tsx packages/web/tests/resizable-shell.test.ts packages/web/tests/skin-system.test.ts packages/web/tests/group-collaboration.test.ts packages/web/tests/save-reply-as-document.test.ts packages/server/tests/group-per-character-model.test.ts packages/harness-adapter/tests/model-router-lifecycle.test.ts --maxWorkers=1
pnpm exec vitest run packages/persistence/tests/sqlite-store.test.ts --maxWorkers=1
pnpm exec playwright test e2e/chat-visual-redesign.spec.ts e2e/chat-delivery-quality.spec.ts e2e/conversation-control-runtime-lanes.spec.ts e2e/settings-model-ux.spec.ts e2e/world-scene-skin-decoupling.spec.ts e2e/connection-hub.spec.ts e2e/web-search-hub.spec.ts e2e/machine-profile-device.spec.ts e2e/skill-center-entity-aggregation.spec.ts
```

相关单元／集成测试 92 项通过。相关浏览器用例共 18 项通过，覆盖本次视觉、菜单、模型配置以及上一批聊天恢复。构建和原有 bundle budget 通过，命名皮肤 CSS 按需加载。

默认视觉链路的浏览器 error/warn 记录为空；连接测试使用不可达的测试 MCP 地址时，宿主记录预期的目录刷新警告。故障恢复测试继续记录预期的注入网络错误。

## 验证边界

测试 Runtime 为确定性本地实现。路由、状态、文件和 UI 路径均使用真实服务和持久化，模型内容质量沿用真实模型配置后的验收流程。验收重点为桌面工作台及 1100px 较窄窗口。
