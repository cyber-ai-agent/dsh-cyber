# DeepSeek Harness 0.1.5-rc.2 兼容性矩阵

核对日期：2026-09-14

## 发布基线

上游最新正式发布标签为 `dsh-v0.1.5-rc.2`，发布时间为 2026-09-10，标签提交为 `fb2c4b9e698e30edb738bca4cf0618587db7d203`。npm 的 `latest` 通道保持 `0.1.5-rc.1`，`next` 通道指向 `0.1.5-rc.2`；DSH Cyber 采用 GitHub 最新发布标签对应的精确版本，并在代码与锁文件中统一固定。

来源：

- [DeepSeek Harness tags](https://github.com/deepseek-ai/deepseek-harness/tags)
- [dsh-v0.1.5-rc.2 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.2)
- [dsh-v0.1.5-rc.1 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1)
- [@deepseek-ai/dsh npm versions](https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions)

## 兼容性矩阵

| 边界 | 0.1.2-rc.1 基线 | 0.1.5-rc.2 结果 | DSH Cyber 适配与证据 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh`、CLI | 精确锁定 | 精确锁定 | `SUPPORTED_HARNESS_VERSION`、candidate inspector、激活版本门禁 |
| SDK Client | `DeepSeekHarness.session().run()` | API 保持可用 | 同一 lane 复用会话，真实 loopback smoke 通过 |
| JSON-RPC Server | `initialize`、`session/prompt`、`shutdown` | 方法与返回形状保持可用 | `HarnessSdkJsonRpcServer` 加载成功，协议合同通过 |
| 协议与流式事件 | `session.event`、`session.status`、`subagent.*` | 事件名称与核心字段保持可用 | `normalizeHarnessTraceNotification`、工具/审批轨迹回归通过 |
| Session 生命周期 | 命名 Session 创建 | `SessionHandle` 生命周期、异步 `agentLoop.create`、跨进程 Session lock | 适配层继续以 conversation lane 管理上下文；重启前生成新随机 DSH Session ID |
| Session 日志格式 | V2 | V3 | 上游 JSONL backend 读取 `session.v2` 并发布 V3 后继代；`session-format-migration.test.ts` 固定系统提示词、PTC/预设与消息顺序迁移 |
| 默认文件工具 | `str_replace_editor` 可由补丁开启 | `read/write/edit` 成为 SDK 默认工具 | Bundle 移除已消失的 `tool-str-replace-editor` 条目，`str_replace_editor` 保持按需配置，工具 schema 实测 8,671 tokens |
| 审批 | `approval/request` + `approval/decide` | 同一审批词汇与事件闭环 | Bundle 保留精确请求 ID 反查与单次决定，真实文件权限测试通过 |
| 工具结果 | `user-message -> tool-result` 投影 | 结果事件与脱敏投影保持可用 | 工具结果摘要、原始返回片段和失败码回归通过 |
| 并发 lane | 每角色最多 2 条 | 适配层边界保持 | closing reservation、重试、取消与审批路由回归通过 |
| Worker profile | `dsh-base` + DSH Cyber bundle | peer 依赖全部精确对齐 | `pnpm peers check` 通过；所有显式 DSH peer 固定到 `0.1.5-rc.2` |
| 本地 stateRoot | SQLite、世界、Workshop、Skill、资产 | 领域数据格式保持 | Harness 日志位于 runtime 私有目录；本地 Backup Bundle 继续覆盖用户持久化根 |
| 激活与回滚 | pointer + candidate canary | 精确版本、合同、金丝雀、备份后激活 | `RuntimeUpdateService`、完整本地 Bundle、active-runtime gate 回归通过 |

## 上游变更的适配落点

- V2 → V3 Session 迁移由上游 `@deepseek-ai/dsh-session-format-v2-to-v3` 与 JSONL persistence backend 持有；DSH Cyber 记录当前 Session format 版本与支持迁移边。
- Session lock 与生命周期句柄由 SDK runtime 处理；DSH Cyber 保留自身的 conversation-to-lane 映射、恢复输入预算和安全随机 Session ID 生成。
- 默认工具组合由 `cordis.patch.yml` 的可用条目决定；Bundle 继续显式挂载 Bash、PowerShell、FS、搜索、Workflow 与 Ralph 工具。
- 预发布 peer 依赖由 Bundle 的显式依赖声明持有，运行时解析得到单一 DSH 版本集合。

## 本地数据与升级边界

升级前先生成完整本地 Bundle，随后执行 candidate verify → contract test → canary → explicit activation。Bundle 覆盖 SQLite、`worlds/`、`assets/`、`packages/`、`workshop/`、`skills/`、`integrations/` 与 `environments/`；凭据、运行时二进制、缓存和历史备份保持独立。

DSH JSONL 会话属于 runtime 私有执行投影，领域会话事实继续来自 DSH Cyber SQLite。V2 日志由上游读路径迁移，源 generation 保留，V3 后继 generation 采用同一物理会话目录。

## 验证记录

- `pnpm peers check`：通过。
- `pnpm run typecheck`：通过。
- `pnpm run build`：通过，前端构建预算通过。
- `pnpm exec vitest run packages/harness-adapter/tests packages/harness-bundle/tests packages/server/tests/harness-compatibility-contract.test.ts packages/server/tests/runtime-version-gate.test.ts`：通过。
- `pnpm run test:migration`：覆盖 SQLite、队列 lease、completion repository、本地备份恢复和 V2 → V3 Session 迁移。
- 真实 loopback Worker：覆盖流式输出、工具事件、文件权限、单次审批、会话恢复、World Directory 与 V3 日志落盘。

## 复核事项

- `0.1.5-rc.2` 仍属于预发布版本，生产发布需继续保留 candidate canary 与完整 Bundle 备份流程。
- DeepSeek 官方 release notes 标记 Session V3 仅支持向前迁移；降级路径依赖激活前的完整 Bundle 与旧 runtime candidate。
- 远程模型、Firecrawl 与本地连接服务商的凭据继续由 DSH Cyber 连接中心管理，Worker 只接收白名单环境变量。
