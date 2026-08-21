# 模型交互日志模块

本模块记录服务端可观测到的模型 API 交互，用于排查「某次对话/模型发现为什么失败、耗时多少、走了哪个模型」等运行问题。日志只存请求摘要统计，**绝不保存 API 密钥、prompt 明文或响应明文**（与 AGENTS.md 凭据红线一致）。

## 采集点与观测边界（必读）

模型 API 的实际请求发生在 DSH worker 进程内部（harness-adapter 的 model-router / adapter），服务端**无法逐请求观测**。因此本模块在两个服务端可见的位置采集，并如实标注边界：

| 采集点 | source | 观测内容 | 边界 |
| --- | --- | --- | --- |
| 对话回合（server 用 `TurnInteractionLoggingRuntime` 装饰器包住 `AgentRuntimePort`，见 `packages/server/src/server.ts`） | `turn` | 服务端发起的**整轮** turn 交互：开始时间、模型 ID、provider（来自模型路由解析；未配置路由时为 `dsh-default` / `默认 DSH 模型`）、成功/失败、耗时、工具调用次数、最终响应字符摘要 | 不是单次模型请求；worker 内部发生了几次请求、每次多少 token，服务端不可见 |
| `/models` 模型发现（`model-catalog-service.discover` 调用处，见 `packages/server/src/routes/model-routes.ts`） | `discovery` | 真实 HTTP 往返：成功/失败、状态码（`ServiceError.code`）、耗时 | GET 请求无 prompt，请求摘要恒为 0 |

运行时升级金丝雀走独立 runtime（无 workspace 归属），不记录。

## 记录字段与数据口径

每条日志字段见 contracts 的 `ModelInteractionLog`（`packages/contracts/src/index.ts`）。以下口径在使用日志做分析时必须先明确，**不能混算**：

1. **token 用量字段当前恒为空**：需求约定「若接口返回才填」。但 DSH worker 内部的单次请求 token 用量没有透出到服务端，因此 `tokensPrompt / tokensCompletion / tokensTotal` 目前**永远填不上**（字段已预留，落库为 NULL，前端显示 `—`）。拿到真实 token 数需要到 harness-adapter 的 model-router / adapter.ts（worker 进程内）采集并透出，属于后继迭代项——**不是本模块坏了**。
2. **`durationMs` 是双语义**：`turn` 级是**整轮延迟**（从服务端发起 turn 到 worker 返回，含全部工具调用）；`discovery` 级才是**单次 HTTP 往返**。前端用 source 徽标（对话回合/模型发现）区分，做报表/性能分析时两类必须分开。
3. **`promptMessageCount` 是近似值**：turn 级按「1 条用户 prompt + 每轮工具回填 1 条」估算（即 `1 + toolCallCount`），不是真实发送给模型的消息条数；`responseCharCount` 只含**最终响应**字符数（`result.finalResponse.length`），不含中间工具输出。`promptCharCount` 为 prompt 实际字符数（只取 `.length`，不存原文）。

## 隐私红线

- 请求只存摘要统计（消息数 / 字符数），不存 prompt 原文与响应原文；错误信息可存。
- 错误信息落库前在 service 层统一清洗（`sanitizeErrorMessage`，见 `packages/server/src/services/model-interaction-service.ts`），覆盖三类密钥模式并替换为 `[已隐藏]`：
  - `sk-…` 形式（`\bsk-[A-Za-z0-9_-]{8,}\b`）
  - `Bearer …` 形式
  - `api_key=` / `access_token=` / `secret=` / `password=` 等键值形式
- 清洗后截断 500 字符。
- 单测与 e2e 均断言「日志 JSON 不含 prompt 明文」；集成测试断言错误码正确落库。

## 持久化

SQLite 新表 `model_interaction_logs`（走项目现有 migration 机制，v11，见 `packages/persistence/src/migrations.ts`）：

- STRICT 表，主键 `id`；`workspace_id` 必填且级联删除，`world_id / session_id / employee_id` 可选（级联删除）。
- 约束：`source` ∈ turn/discovery，`status` ∈ success/failed，计数与耗时字段非负。
- 索引：`(workspace_id, created_at DESC, id)`、`(workspace_id, status, created_at DESC, id)`、`(workspace_id, model_id, created_at DESC, id)`——覆盖列表默认排序与状态/模型筛选。
- 存储层方法（`packages/persistence/src/sqlite-store.ts`）：`recordModelInteraction`（含归属与字段校验）、`listModelInteractions`（分页+筛选+去重 modelIds）、`getModelInteraction`、`clearModelInteractions`。

## 查询 API

前缀 `/api/workspaces/:workspaceId/model-interactions`（`packages/server/src/routes/model-interaction-routes.ts`）：

| 方法/路径 | 说明 | 校验与边界 |
| --- | --- | --- |
| `GET .../model-interactions` | 列表（分页） | `page`≥1（默认 1）、`pageSize` 钳制 1–100（默认 20）；`status` 白名单（非 success/failed 返回 422 `invalid_status_filter`）；`modelId` 可选筛选；排序 `created_at DESC, id DESC` 稳定翻页不重不漏；响应含去重 `modelIds` 供前端下拉 |
| `GET .../model-interactions/:id` | 详情 | 校验日志归属该 workspace，否则 404 `model_interaction_not_found`（防跨工作区泄露） |
| `DELETE .../model-interactions` | 清空 | 删除该 workspace 全部日志，返回 `{ removed }`；非 GET 请求需带 `application/json` Content-Type（服务端安全护栏约定，前端 api.ts 已按此处理） |

## 前端界面

「设置」面板新增「日志记录」栏目（`packages/web/src/components/SettingsDialog.tsx`）：

- 列表：时间 / 模型 ID + provider / source 徽标（对话回合/模型发现）/ 状态（成功/失败）/ 耗时 / token（无则 `—`）。
- 筛选：状态（全部/成功/失败）+ 模型（去重下拉，无数据时禁用）。
- 详情：点击行展开（记录时间、source、模型、provider、状态、错误码、错误信息、消息数/字符数、工具调用次数、耗时、token 明细）。
- 清空按钮 + 分页；空态两种：无任何日志 vs 筛选无结果。
- 视觉证据（AGENTS.md 护栏）：三视口截图 + 控制台 error/warn 记录，见验证一节。

## 测试与验证

- `pnpm verify`：20 个测试文件 / 119 个测试全部通过（typecheck + build + vitest），含存储层单测（记录/列表/筛选/分页/清空/持久化/校验）与 API 集成测试（turn 成功/失败、discovery 失败、筛选、详情、清空）。
- `pnpm test:e2e`：7 个 e2e 全部通过；日志面板用例覆盖「发消息产生真实日志 → API total 断言 → 面板列表 → 详情展开（且详情不含 prompt 明文）→ 状态筛选 → 清空 → 空态」，并产出三视口截图与 console 记录供视觉审批。
- 视觉审批（合并门禁）：截图 `artifacts/ui-world-conversations/model-logs-{1440x900,1920x1080,3840x2160}.png` + `model-logs-console.log`，需视觉岗按 AGENTS.md 护栏逐项查验。

## 已知限制与后继迭代（不阻塞当前合入）

1. **真实 token 用量**：需在 harness-adapter（worker 进程内）采集单次请求 token 并透出到服务端，`tokens_*` 字段才有值。
2. **保留策略**：日志表目前只支持手动清空，无自动清理/条数上限，长跑后表会无限增长（现有索引 + 分页钳制下短期无性能风险），建议后续加自动清理策略。
3. **错误清洗单测**：`sanitizeErrorMessage` 的密钥替换行为暂无直接单测（现有断言覆盖「不含 prompt 明文」与错误码落库），建议补一条喂含 `sk-…` / `Bearer …` 错误消息验证 `[已隐藏]` 的单测，作为隐私红线的直接证据。
