# 聊天交付体验第一批优化

目标：私聊交代任务 → 处理中补充 → 切换会话 → 返回查看结果 → 保存文档、查看产物、确认任务或继续修改。

## 基线与边界

- 分支：`codex/chat-delivery-quality`。
- 已执行 `git fetch origin --prune`，从 `origin/main` 建立分支。
- 开始修改时，HEAD、origin/main、merge-base 均为 `ac09957df83773c97ef39da7b68cd497ab7e2810`。
- 原工作区的 `.playwright-cli/` 保留。测试服务使用系统临时目录下的独立 `stateRoot`，日常用户数据保持原状。
- 沿用 Conversation Queue、WorkTurn、AgentRun、来源任务确认和 Artifact 发布。数据库 schema、执行权限和世界信息架构保持现有契约。
- Browser plugin not available：使用仓库 Playwright / Chromium 工作流及 Playwright MCP 检查页面。

## 简短审计

A = 浏览器实际复现；B = 静态风险；C = 可用性改进。

| 场景 | 问题与证据 | 影响 / 优先级 | 模块与验收 |
|---|---|---|---|
| A 中文选字 | `isComposing` / 229 Enter 触发发送并清空草稿 | 误发半成品，P1 | ChatWorkbench；组合输入保留、普通 Enter 发送、Shift+Enter 换行 |
| A 提交校验失败 | 422 后输入为空，附件草稿数为 0 | 无法继续编辑原要求，P1 | submission store/delivery/recovery；失败内容可跨切换和刷新恢复 |
| A 网络响应丢失 | 服务端已接收时，客户端需要核对提交结果 | 新提交可能重复执行，P1 | 保留原 clientTurnId 与完整请求；两次 HTTP、一次 Runtime、一条用户消息、一条回复 |
| A 白天模式 | 世界深色背景变量覆盖浅色界面变量，标题与状态出现混合配色 | 阅读困难，P1 | styles/world settings；默认皮肤完整浅色配色，保留世界画布 |
| A 多行输入 | 七行内容为 172px，输入区固定 68px | 只能看到末尾几行，P2 | 输入自动增高至 180px，再局部滚动 |
| C 补充与交付入口 | 队列使用“插入”；保存回复依赖右键，保存后需另找文件 | 执行时机和下一步不清晰，P2 | 待处理消息、排队发送、回复操作、查看文档；真实按钮点击 |
| A 阅读长回复 | CompletionJob 完成刷新先清空同会话正文，丢失滚动位置 | 阅读中跳回最新消息，P1 | App transcript；同会话合并更新，世界/会话/请求代际检查保留 |
| B 排队编辑 | editQueuedTurn 的取消结果、草稿闭包与附件恢复需要进一步核对 | 排队内容恢复风险，P1 后续 | 下一批先复现取消失败、编辑期间切换和带附件编辑 |

## 实现说明

- 发送与服务端执行状态分开。提交回执按世界和稳定会话 owner 存在标签页 sessionStorage；刷新将未确认的发送标记为结果待确认。回执只保存用户自己的提交与附件引用。
- 重试提交复用原始请求字节及 clientTurnId，由现有服务端 ingress 去重。成功接收后重新读取权威队列；晚到的接收响应由当前队列状态校正。
- 明确校验拒绝可恢复到输入框；已有新草稿时保留两份内容并暂时禁用恢复。连接结果不明时提供同一提交的核对重试。
- 输入法同时检查 composition 状态、`isComposing` 和 229。输入框随文字、会话和宽度变化调整高度。
- 默认皮肤的白天模式使用一致的阅读背景、正文和状态颜色。正文使用现有字体变量，辅助文字至少 12px；队列计数集中在队列标题。
- 回复使用现有 ContextMenu，新增可见入口；保存仍调用已有 `save-reply`，文档保持“由你手动发布”的来源语义。
- 同会话刷新保留已加载历史和 DOM；切换会话时清除旧正文，继续验证世界、会话与请求代际。

## 验收与证据

截图与 JSON 位于当前任务的本地证据目录：

`C:/Users/Administrator/.codex/visualizations/2026/09/20/01a0bf8a-33fe-7421-b2f9-aee1241c92a5/`

- 前后截图：`before-light-{尺寸}.png`、`after-light-{尺寸}.png`。
- 失败恢复：`before-failure-1440x900.png`、`after-failure-1440x900.png`。
- 交付与验收：`delivery-document-1440x900.png`、`delivery-accepted-1440x900.png`、`delivery-evidence.json`。
- 去重与阅读：`retry-evidence.json`、`reading-evidence.json`、`long-reading-1440x900.png`。
- 深色兼容：`after-dark-1440x900.png`。
- 控制台：正常链路记录为空；故障注入分别记录预期的 422 和 `ERR_CONNECTION_RESET`。

视口：1440×900、1920×1080、3840×2160、1100×760。每档检查画布覆盖、布局空白、对比度、中文文案、最小字号、输入与队列可读性；详细指标保存在 `delivery-evidence.json`。4K 的消息正文有最大阅读宽度，短会话保留可用阅读空间。

| 视口 | 图片适配 / 空白 | 对比度 / 最小字号 | 语言与可读性 |
|---|---|---|---|
| 1440×900 | 画布铺满；聊天阅读区正常 | 输入区最低 5.35:1，队列最低 5.84:1；辅助文字 12px | 中文操作；七行草稿完整可见 |
| 1920×1080 | 画布铺满；阅读行长受控 | 同上 | 中文操作；输入和排队控件可达 |
| 3840×2160 | 画布铺满；正文与输入区保持最大阅读宽度 | 同上 | 中文操作；保留大屏阅读空间 |
| 1100×760 | 画布铺满；聊天主体可用 | 同上 | 核心聊天操作可达；全局工具栏另列后续 |

指标中的 `composerVisual.overflow = 195` 来自宽度 1px、透明的原生文件选择 input；实际工作台水平溢出为 0。上传通过可见的“添加附件”按钮触发原生文件选择器。

## 可复现检查

```powershell
pnpm run typecheck
pnpm run build
pnpm exec vitest run packages/web/tests/chat-control-ui.test.ts packages/web/tests/chat-submission-store.test.ts packages/web/tests/chat-realtime.test.ts packages/web/tests/composer-draft-store.test.ts packages/web/tests/save-reply-as-document.test.ts packages/web/tests/skin-system.test.ts packages/server/tests/conversation-ingress-service.test.ts packages/server/tests/conversation-control.test.ts packages/server/tests/source-task-completion.test.ts packages/server/tests/turn-aware-approval-continuation.test.ts packages/server/tests/group-skill-approval-continuation.test.ts packages/server/tests/conversation-context-composer.test.ts packages/server/tests/employee-conversation-memory-service.test.ts --maxWorkers=1
pnpm exec playwright test e2e/chat-delivery-quality.spec.ts e2e/chat-draft-isolation.spec.ts e2e/conversation-control-runtime-lanes.spec.ts e2e/source-task-completion.spec.ts e2e/runtime-reconnect.spec.ts e2e/group-task-router.spec.ts e2e/task-cancel.spec.ts
```

`DSH_AUDIT_SCREENSHOT_DIR` 可指定截图目录。默认位于系统临时目录。构建已包含现有 bundle budget 检查。

已完成的相关单元与集成检查：13 个文件、93 个测试通过。并发重载时曾出现 15 秒超时与 Windows 临时目录清理失败，单独重跑 11 个相关测试通过，随后上述完整命令以单 worker 全部通过。

浏览器回归：新增 5 条交付用例和既有 10 条相关用例通过。视觉门禁曾识别到 10px 的重复队列计数，修正后新交付用例全部通过。构建的分包大小提示仍会出现，仓库规定的各项 bundle budget 均通过。

## 验证范围与下一批

- 这批使用确定性测试 Runtime、真实 HTTP / SQLite / 队列 / 产物文件。证据验证执行顺序、持久化、恢复和界面行为。
- 当前环境的 `OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`DSH_API_KEY` 均为空。真实模型的理解质量、长任务完成质量留待配置真实模型后评估。
- 中文输入法验证采用浏览器 composition / keyCode 事件；原生 Windows 候选窗人工验收仍有价值。
- 先处理排队编辑的原会话恢复、附件保留与取消竞争；随后检查自定义皮肤的浅色配色和较窄窗口的全局工具栏。
- 待确认回执继承现有草稿的标签页生命周期。关闭标签页后的恢复范围可在下一批另行评估。
