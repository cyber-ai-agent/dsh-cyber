# 群聊 Skill 审批续跑 V1

群聊讨论和任务协作在创建 AgentRun 前进入与私聊相同的 CharacterSkillRuntime 与 Approval Gate。SQLite 继续保存会话、工作回合、技能动作、审批请求和运行结果。

## 生命周期

```text
Group WorkSession
└─ queued WorkTurn
   ├─ SkillAction
   │  └─ ApprovalRequest
   ├─ TaskCollaborationPlan
   └─ AgentRun
```

队列领取 WorkTurn 后，系统按照群聊成员顺序寻找第一个能够处理当前外部动作且拥有有效授权的角色。同一用户回合只允许该角色生成一个宿主动作，额外 proposal 在持久化和执行前截断，避免多个角色或多个动作对同一目标重复调用外部服务。

没有外部动作时直接进入讨论或任务协作。动作可以安全立即执行时，真实结果进入群聊运行上下文。动作需要审批时，WorkTurn 和 Queue Entry 转为 `waiting-approval`，不创建 AgentRun，也不占用角色运行通道。

## 审批结果

- 批准：重新检查当前世界、角色、Skill Grant、世界包实例、连接和审批策略；Adapter 只执行一次。系统恢复原 WorkTurn，再创建群聊 AgentRun。
- 拒绝：不执行 Adapter。原 WorkTurn 继续，角色只能根据“操作未执行”的持久化事实回复。
- 过期：与拒绝使用同一安全边界，不执行 Adapter，也不重新 prepare。
- 结果未知：不自动重试。后续群聊只能说明外部结果未知。

批准、拒绝和过期都不会创建第二条用户消息、第二个 WorkTurn 或重复 SkillAction。任务协作计划仍绑定原 WorkTurn。

## 重启恢复

`waiting-approval` 会跨服务重启保留。重启后审批仍绑定原会话和 WorkTurn；批准后继续原群聊，Adapter 与用户消息各只出现一次。正在执行的外部请求仍遵守结果未知且禁止盲目重试的规则。

## 安全与展示

聊天只显示用户消息、最终角色回复、轻量任务分配和审批卡。SkillAction、Adapter、审批状态、工具事实和错误继续进入轨迹，并经过统一脱敏。

群聊外部动作不授予 `danger-full-access`。Browser、Firecrawl、MCP 和其他 Adapter 继续使用各自 Descriptor 声明的审批范围。
