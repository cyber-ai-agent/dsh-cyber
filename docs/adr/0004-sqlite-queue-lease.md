# ADR 0004: SQLite Conversation Queue Claim 与 Lease

- 状态：Accepted
- 日期：2026-08-27

## 背景

Conversation Queue 已持久化，但运行所有权仍主要依赖进程内调度状态。进程崩溃、多 Worker 竞争和等待审批 continuation 缺少统一的数据库租约事实。

## 决策

Queue Entry 增加 `leaseOwner`、`leaseExpiresAt`、`attemptCount`、`availableAt` 和 `priority`。Worker 使用 SQLite 原子条件更新 claim；只有获得 claim 的 Worker 可以推进对应 WorkTurn。运行期间周期续租，停止时释放。

启动恢复会回收过期 running、无活跃 AgentRun 的租约项和进程崩溃遗留项。等待审批释放员工 lane，但继续占用 session 顺序锁；批准、拒绝或过期继续原 WorkTurn。

入队/审批/停止事件主动唤醒 scheduler，低频轮询只作兜底。无法证明外部副作用结果的项转为 recovery-required，不自动重试。

## 结果

- 双 Worker 竞争只有一个执行者。
- 重启恢复不依赖旧进程内 Map。
- 保持不同会话并发与同会话顺序执行。

## 非目标

本 ADR 不引入分布式队列服务，也不把 SQLite lease 描述为跨机器强一致调度平台。
