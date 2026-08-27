# ADR 0002: Employee Presence 与 Health 拆分

- 状态：Accepted
- 日期：2026-08-27

## 背景

一个角色可以在两个不同会话并发运行，但旧模型只有可写的 `working/available/blocked` 单字段。任一 Run 结束都可能覆盖另一个仍在运行的事实；普通模型失败也可能把长期角色状态错误标记为 blocked。

## 决策

把运行投影拆为：

```text
EmployeePresence = available | working
EmployeeHealth   = healthy | degraded | blocked
```

Presence 由当前活跃 AgentRun、waiting-approval WorkTurn/Queue 和需要恢复的 TaskRun 派生，不允许单个 Run 直接写 available。启动时从持久事实重算。

普通模型、网络或单回合工具失败只结束当前 Run。只有凭据缺失、模型配置损坏、Runtime 不兼容、权限策略损坏或必需 Skill 不可用等持续、可操作问题才能改变 Health；Health 记录稳定 errorCode、用户可理解说明和修复建议。

## 结果

- 同员工双会话中先结束的 Run 不会提前显示空闲。
- 世界、角色列表、Dossier 和 Task 面板读取同一投影。
- 环境故障和业务回合失败不再混为一谈。

## 非目标

本 ADR 不提高每角色运行通道上限，也不改变同会话顺序锁、审批 continuation 或 Harness lane 生命周期。
