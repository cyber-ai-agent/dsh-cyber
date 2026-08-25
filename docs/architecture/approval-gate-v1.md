# Approval Gate V1

Approval Gate V1 为受信任 Skill Adapter 的外部副作用提供本地、持久且不可绕过的审批边界。Home Assistant、Firecrawl 和 MCP 动态工具都经过这一边界。

## 执行链

```text
Skill proposal
  → WorkSession / WorkTurn
  → durable Skill Action
  → Approval Request or active exact-target Policy
  → current character and Skill Grant check
  → current World Package and Integration check
  → durable execution claim
  → trusted Skill Adapter
  → durable result
  → AgentRun in the same WorkTurn
```

外部副作用在审批前保存为 `waiting-for-approval`。只有持久化审批已经批准，或存在完全匹配的有效策略，运行时才会调用 Adapter。拒绝和过期会把动作终止为 `rejected`。

通过聊天创建的 Action 会同时绑定 `sessionId` 和 `workTurnId`。等待审批时，`WorkTurn` 持久为 `waiting-approval`，不保持 DSH Worker。批准、拒绝或过期后，系统继续同一个 `WorkTurn`，新建 `AgentRun` 生成最终事实回答，不重放整个用户回合。

执行前会再次确认世界、角色、当前 Skill Grant、World Package 声明、Integration 连接和审批策略。撤销授权或连接失效后，旧审批不能绕过重新检查。

## 精确复用策略

只有 Descriptor 明确声明 `persistentApproval: exact-target` 的技能才能创建可复用策略。策略支持角色级和世界级作用域，并绑定以下全部字段：

- Subject Type
- Skill ID
- Action
- Target
- Risk
- World
- Character，适用于角色级策略

目标、动作或风险发生变化时必须重新审批。系统不提供“永久允许整个插件”或“永久允许全部外部动作”的宽泛授权。

策略键是 `(skillId, action, target, risk)`，**永不包含 `parameters`**。因此只有当一个技能的语义完全由目标和动作决定时，才可以声明 `exact-target`；语义装在参数里的技能（例如搜索查询）必须声明 `forbidden`，直到参数约束和策略指纹存在为止。

MCP 动态工具与 Firecrawl 都声明 `persistentApproval: forbidden`，因此只允许 `once` 审批。Home Assistant 保留精确目标策略：它的目标和动作已经完全确定了语义，`parameters` 恒为空。

## 中断与重试

审批结果和执行边界是两个独立的持久状态。审批已通过但尚未获得执行权时，重启可以继续安全执行。动作通过 compare-and-set 从 `approved-ready` 进入 `executing`，只有获得持久执行权的进程才能调用 Adapter。

进入外部请求边界后如果进程中断，重启会把动作标记为 `outcome-unknown`。系统不会自动重试可能已经产生副作用的动作。`waiting-approval` 会跨重启保留，不会被当作中断运行标记失败。

## 本地 API

- `GET /api/worlds/:worldId/approvals?status=pending`
- `POST /api/approvals/:approvalId/decision`
- `GET /api/worlds/:worldId/approval-policies`
- `DELETE /api/approval-policies/:policyId`

决策请求使用 `decision` 字段，可选值为 `approved` 或 `rejected`。批准时可使用 `scope` 字段选择 `once`、`character` 或 `world`。拒绝始终按单次决策处理。

所有接口沿用世界访问锁。决策主体由本地服务确定，客户端不能提交任意身份冒充审批人。

## 当前范围

Approval Gate V1 覆盖通过 `CharacterSkillAdapter` 提出的 `external-side-effect` Skill Action。通用文件写入审批、独立审批中心界面和远程审批同步尚未实现。
