# DeepSeek Harness 0.1.6-alpha.1 兼容性矩阵

核对日期：2026-09-16

## 发布基线

DSH Cyber 精确锁定 `dsh-v0.1.6-alpha.1`，发布时间为 2026-09-15，标签提交为 `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`，npm 通道为 `alpha`。Session 日志格式继续使用 V3，V2 日志由上游迁移包读取并生成 V3 后继代。

来源：

- [dsh-v0.1.6-alpha.1 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.1)
- [dsh-v0.1.6-alpha.1 source tag](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.6-alpha.1)
- [@deepseek-ai/dsh npm versions](https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions)

## 兼容性矩阵

| 边界 | 0.1.6-alpha.1 变化 | DSH Cyber 适配 |
| --- | --- | --- |
| CLI 与 SDK | SDK Client、JSON-RPC Server 和 Session 事件协议保持可用 | 所有显式 DSH 包精确锁定；candidate inspector、版本门禁和真实 worker canary 覆盖 |
| PTC | `code-runtime` 演进为独立进程 `ptc-runtime`，默认超时 120 秒，环境从空对象开始 | Bundle 改用 `dsh-ptc-runtime`、`dsh-ptc-runtime-node`；凭据继续由宿主变量和工具执行边界提供 |
| Workflow | 执行器采用 `workflow-ptc` | Bundle 显式包含 `dsh-workflow-ptc`，原有 Workflow 工具入口保持 |
| Session 读取 | `eventAt`、`snapshotEvents`、`ownEvents` 进入弃用阶段 | 审批关联和提前工具结果裁剪改为同步 `session/event` 投影 |
| Session 格式 | V3 保持 | `session-format-v2-to-v3` 精确升级，迁移测试与恢复预算保持 |
| Skill | 上游提供 scoped Skill registry、文件系统 provider 和 model-facing loader | 上游 registry 保留；ambient 项目/用户目录发现关闭，安装、激活、世界/角色授权继续由 DSH Cyber PackageManager 与 Skill Runtime 持有 |
| MCP | SDK v2、资源发现/读取、URI 模板和分页 | DSH Cyber 连接中心继续按服务聚合工具，并保持 Grant、Approval、Action Ledger 与凭据脱敏边界 |
| Context | Token 估算、图片 offload、持久 Bash 和 compaction 更新 | `token-meter`、`compaction-basic`、`tool-result-pruner` 精确升级；原始工具结果继续在下一次模型请求前裁剪 |
| 凭据 | `credentials-local` 按引用逐操作解析；Node PTC 进程环境为空 | 当前加密凭据库、变量描述符、shellEnv 注入和工具前后置脱敏继续作为产品权威边界 |
| DeepSeek 协议 | 官方默认切换到 Messages，Files API 可复用图片 | 自定义与本地模型路由保持显式 API 类型；官方端点升级由模型中心配置和合同测试控制 |
| 本地数据 | Runtime cache、Session 日志和附件布局扩展 | SQLite、世界、资产、包、Workshop、Skill、连接仍由 `stateRoot` 权威持有并进入完整 Backup Bundle |

## 安全与产品边界

- DSH Cyber Worker 保持 SDK-only，不挂载上游 Web 终端、浏览器或轨迹界面。
- Upstream Skill 文件系统的默认项目目录、用户目录和自定义目录全部关闭；后续 trusted provider 只投影已安装、已激活、已授权的固定包目录。
- MCP、Browser Use、Computer Use 与远端工作区继续通过独立 Adapter 接入，角色名称和自然语言声明不产生权限。
- Trace 继续只保存有界、结构化、凭据安全的工具事实；上游可展开 JSON 和 PTC 结果不直接进入产品轨迹。
- Ralph 由 DSH Cyber 显式开启，仍受世界权限、审批和执行记录约束。

## 验证门禁

- `pnpm peers check`：通过。
- `pnpm run typecheck`：通过。
- `pnpm run build`：通过，前端构建预算通过。
- 对话首屏实际加载 JavaScript 从 2,204,942 bytes 降至 1,977,134 bytes，创意工坊、知识、模型和连接翻译随对应功能按需加载。
- Harness Adapter、Bundle、Session migration、runtime gate 与真实 loopback Worker：通过。
- 全量 Vitest：381 个测试文件通过，2246 项通过，1 项跳过。
- 核心浏览器 smoke：32 项通过；懒加载翻译包专项 16 项通过。
- 激活前完整本地 Backup Bundle、candidate contract、真实 canary 与显式 activation

`0.1.6-alpha.1` 继续使用预发布兼容策略。生产升级保留精确版本、完整备份、金丝雀和可恢复激活流程。
