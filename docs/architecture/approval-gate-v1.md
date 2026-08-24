# Approval Gate V1

Approval Gate V1 为受信任 Skill Adapter 的外部副作用提供本地、持久且不可绕过的审批边界。当前 Home Assistant 控制动作属于这一边界。

## 执行链

```text
Skill proposal
  → durable Skill Action
  → exact Approval Request or active Policy
  → current character and Skill Grant check
  → trusted Skill Adapter
  → durable result
```

外部副作用在审批前保存为 `waiting-for-approval`。只有持久化审批已经批准，或存在完全匹配的有效策略，运行时才会调用 Adapter。拒绝和过期会把动作终止为 `rejected`。

执行前会再次确认角色仍存在、未归档、属于当前世界，并且当前 revision 仍持有对应 Skill Grant。撤销授权后，旧审批不能继续驱动动作。

## 精确复用策略

可复用策略只支持角色级和世界级作用域，并绑定以下全部字段：

- Subject Type
- Skill ID
- Action
- Target
- Risk
- World
- Character，适用于角色级策略

目标、动作或风险发生变化时必须重新审批。系统不提供“永久允许整个插件”或“永久允许全部外部动作”的宽泛授权。

## 中断与重试

调用外部 Adapter 前，动作先持久化为 `waiting-for-integration`。应用在该阶段中断时，重启恢复会把动作标记为 `outcome-unknown`。系统不会自动重试可能已经产生副作用的动作。

## 本地 API

- `GET /api/worlds/:worldId/approvals?status=pending`
- `POST /api/approvals/:approvalId/decision`
- `GET /api/worlds/:worldId/approval-policies`
- `DELETE /api/approval-policies/:policyId`

决策请求使用 `decision` 字段，可选值为 `approved` 或 `rejected`。批准时可使用 `scope` 字段选择 `once`、`character` 或 `world`。拒绝始终按单次决策处理。

所有接口沿用世界访问锁。决策主体由本地服务确定，客户端不能提交任意身份冒充审批人。

## 当前范围

Approval Gate V1 覆盖 `external-side-effect` Skill Action。工具调用、文件写入、审批中心界面和远程审批同步尚未实现。
