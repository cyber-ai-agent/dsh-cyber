# ADR 0005: Work System 领域模型

- 状态：Accepted
- 日期：2026-08-27

## 背景

现有 Group Task Router 能在一个群聊回合内生成轻量计划，但缺少用户可管理的长期 Task、分配理由、交付、验收、修改和恢复。另建一套执行 Runtime 会复制 WorkTurn、AgentRun、审批和 Trace，并破坏现有 exactly-once 边界。

## 决策

采用以下关系：

```text
Task -> TaskPlanRevision -> PlanStep -> Assignment -> TaskRun
     -> existing WorkTurn -> existing AgentRun
     -> Deliverable -> Review -> Evidence
```

Task/Plan/Assignment 负责业务意图和协调，TaskRun 只聚合现有执行标识。外部动作继续经过 CharacterSkillRuntime、World Permission 与 Approval Gate。Trace 继续投影现有事实。

现有 TaskCollaborationPlan 通过迁移/适配进入正式 Plan Revision，不长期保留第二套同义模型。所有状态迁移集中在领域状态机，非法迁移 fail closed。

Assignment 必须保存用户指定、技能匹配、当前负载、权限满足和历史证据等结构化选择原因。

## 结果

- Task 可以跨会话和重启存在。
- 执行、权限、Artifact 和 Trace 复用已验证的边界。
- 用户能够看见当前工作、依赖、分配理由和恢复位置。

## 非目标

本 ADR 不实现无限自主委派、无限层级子任务、云端协同或新的 Agent loop。
