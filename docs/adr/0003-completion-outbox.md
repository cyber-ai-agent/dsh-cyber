# ADR 0003: Completion Outbox

- 状态：Accepted
- 日期：2026-08-27

## 背景

Artifact 扫描、索引和知识抽取是主回答完成后的派生任务。把它们放在 AgentRun 完成热路径会让后处理失败反向把已生成的回答标记为失败，也不利于重试和重启恢复。

## 决策

最终消息、AgentRun completed 和 CompletionJob pending 在同一个 SQLite UnitOfWork 中提交。事务成功后主回答即为最终事实；后台 CompletionWorker 通过持久 claim/lease 处理 Artifact、索引和知识派生。

每个 Job 使用稳定 `idempotencyKey`，状态为 `pending/running/retrying/completed/failed/cancelled`。Worker 支持指数退避、最大重试、租约回收和 graceful shutdown。后处理不得重新执行模型回合。

Artifact 引用通过独立关联或受控消息回填保持可追踪；重复 Job 不生成重复 Artifact version。

## 结果

- 回答成功与派生整理成功解耦。
- 用户能看到“整理中/可用/失败”，并只重试后处理。
- 重启后继续 Job，不重放用户请求或外部副作用。

## 非目标

Outbox 不承担普通 Conversation Queue、计划任务或任意后台脚本执行。
