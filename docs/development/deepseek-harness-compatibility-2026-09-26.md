# DeepSeek Harness 0.1.7-rc.2 适配与优化方案

核对日期：2026-09-26。代码基线：`b3bdc4010d5e82fa05cf894aa8f1225ed633c250`。升级前仓库锁定 `0.1.6-alpha.1`；本次目标是 GitHub 标签 `dsh-v0.1.7-rc.2`（`477b4f420553e8a52c2fbccc464d7561b239c443`，2026-09-24）与 npm `next` 通道的同名精确版本。npm `latest` 当日仍指向 `0.1.5-rc.3`，因此这里的“最新”指最新候选版，不宣称已有正式稳定版。

来源：[上游 rc.2 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)、[rc.1 汇总说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1)、[V3→V4 格式说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/packages/session/session-format-v3-to-v4/README.md)。

## 适配范围

| 边界 | 本轮处理 | 验证 |
| --- | --- | --- |
| 依赖闭包 | Adapter、Bundle 的 DSH 包统一精确锁定 `0.1.7-rc.2`；Cordis 同步到满足上游 peer 的 `4.0.4` | frozen install、`pnpm peers check`、类型检查 |
| Session 持久化 | 将候选报告更新为 V4，声明 V2→V3→V4 相邻迁移链；旧格式只在隔离数据中验证，保留原始代 | 迁移 fixture、真实 Worker 重启与 SQLite 历史恢复 |
| 工具事件 | 接受 V4 `tool/result` 的 `role: tool`、`toolCallId` 和 `isError`；继续兼容旧 V3 包装形态；凭据脱敏及证据长度上限不变 | 真实工具权限/审批回合、轨迹单元测试 |
| 上下文预算 | 按当前 Worker 实际发给模型的工具 schema 重新标定固定成本 | loopback 模型捕获请求，检查预算与长上下文拒绝 |
| 产品权限 | DSH Cyber 的只读／当前世界／完全访问仍映射到 DSH 原生模式；世界授权、Skill Grant 和动作审批不从上游 UI 推导 | 六种读写/越界/审批场景的真实 Worker 测试 |
| 本地数据 | SQLite、世界、资产、包、Workshop 和 Skill 动作仍以 `stateRoot` 为权威；DSH Session JSONL 只作运行时缓存 | 完整备份、doctor、服务健康与数据计数核对 |

## 执行顺序

1. **依赖与合同**：统一版本，校验 peer 闭包；候选运行时只接受相同精确版本。任何包漏锁或 Cordis peer 冲突都阻止继续。
2. **会话与工具适配**：核验 V4 迁移边、工具结果结构、错误标志、同回合审批和重启恢复。生产恢复仍从 DSH Cyber 的 SQLite 原文重建新运行时会话，不把旧 DSH JSONL 视为领域事实。
3. **回归与验收**：运行类型检查、构建、Harness Adapter/Bundle、迁移、服务器和浏览器回归；对精确提交等待 required CI，再合并。
4. **本地激活**：先对实际 `stateRoot` 执行 `pnpm dsh-cyber backup`（使用自定义目录时带 `--data-dir`）；通过完整备份验证后，按 `git pull --ff-only`、`pnpm install --frozen-lockfile`、`pnpm build`、`pnpm dsh-cyber doctor`、重启顺序更新。若有已激活的旧候选运行时，先走版本闸门提示的 `runtime-check` / `runtime-rollback`，不得直接改指针或删除日志。

## 已取得的验证证据

- `pnpm peers check`：DSH `0.1.7-rc.2` 与 Cordis `4.0.4` 无 peer 冲突。
- `pnpm typecheck`、`pnpm build`：通过，前端构建预算通过。
- Harness Adapter/Bundle、服务器兼容合同和真实 loopback Worker：26 个测试文件、182 项通过；覆盖原生文件范围、单次审批、工具结果裁剪、凭据变量及重启后的新会话恢复。
- V4 独立测试证明 V2→V3→V4 可用，原 V3 事件未被 DSH Cyber 改写；真实 Worker 写出 `session.v4.jsonl.zstd`。该证据不等于所有历史 V3 日志都可迁移。
- 全量 Vitest 首轮 382 个文件通过，`server.test.ts` 的 4 个旧断言与已合并的“新世界自动招募初始角色并创建 canonical 私聊”不符；已更新断言并单独复测该文件通过。

## 后续优化

- 为升级前诊断增加只读的旧 Session 格式盘点，按 V3、V4、无法读取分别计数；不在用户数据上自动试迁移。上游 V3→V4 会拒绝不满足约束的历史记录，旧格式的可迁移性不能仅凭新会话金丝雀宣称。
- 保持模型可见上下文预算随原生工具 schema 变化进行实测标定，并在版本升级后对长对话、中文和代码输入复测。
- 观察 rc.2 的长输出和长对话修复在当前 Worker 中的真实效果，再考虑修改裁剪阈值；先保留现有凭据脱敏和结果长度边界。
- 上游新增的提醒、插件管理、Team 和桌面 UI 属于其产品层；DSH Cyber 继续通过独立 Adapter 与本地领域模型接入能力，避免把上游界面状态当作当前世界的事实。

## 桌面版候选阶段

可以在本轮兼容适配完成后做 Windows 预览版。桌面入口复用现有本地 Server、Web 工作台与 `stateRoot`，先实现一键启动、端口/进程所有权检查、系统托盘、关闭窗口后任务状态提示和可见的备份/更新入口；然后验证安装、升级、回滚、卸载时本地世界与凭据仍可读。桌面壳不另建会话库或第二套业务 API。Linux/macOS 在 Windows 安装和更新链可靠后再评估，具体壳技术在打包原型中按体积、Node/Worker 兼容性和签名更新成本选择。

本方案不在真实用户目录做迁移演练。代码合并与本地服务切换是两项可分别验证的操作；对正式数据的激活必须先取得备份和健康检查证据。
