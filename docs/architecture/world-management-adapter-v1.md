# World Management Adapter V1

## 作用域

`builtin.world-management` 是一个受宿主信任的、只面向当前 World 的管理 Skill
Adapter。它把有限的自然语言世界管理意图转换成结构化 Proposal，再交给现有
Character Skill Runtime、World Permission Gate、Approval Gate 和 WorkTurn 生命周期。

它不是 AdminRuntime、AdminTurn 或新的 Action Queue，也不让角色直接调用数据库、
文件系统、网络、模型凭据或其他 Adapter。

## 声明式能力

Adapter Descriptor 声明：

- `skillId`、显示名称和中文摘要；
- `adapterId = builtin.world-management`；
- `risk`；
- `authorizationSource = world-authority`；
- `requiredWorldPermission`；
- `persistentApproval = forbidden`；
- 不支持后台调度。

当前管理动作包括：

| 动作 | 所需 World Permission | 作用 |
| --- | --- | --- |
| 读取/修改世界设置 | `world.settings.read/write` | 读取或局部更新当前世界设置 |
| 重命名世界 | `world.settings.write` | 修改当前世界名称 |
| 查看/修改角色 | `world.characters.read/manage` | 读取角色或更新当前世界角色身份 |
| 查看/管理权限 | `world.permissions.read/manage` | 读取或更新角色 World authority |
| 查看/启用/停用插件 | `world.packages.read/manage` | 操作当前 World Package Instance |
| 查看/分配模型 | `world.model.read/assign` | 读取或更新当前世界模型分配 |

Descriptor 是权限和审批策略的唯一声明位置。Runtime 不按 `adapterId` 散落特殊
分支，也不把管理动作伪装成 Marketplace Skill Grant。

## 原始 Prompt 解析

Parser 只接受聊天中原始的用户文本（`promptSource = raw-user`）。角色 Persona、
模型回复、工具结果和 Prompt transform 不能再次生成或改写世界管理 Proposal。

Parser 只产生受限的结构化结果：

```text
kind
skillId
action
target
label
requiredWorldPermission
parameters
```

支持的意图包括当前世界设置/场景/称呼、世界重命名、角色身份、管理员提升/降级、
文件读写权限、插件启停和当前世界模型分配。角色名称必须唯一匹配当前 World；
未知或多义目标返回空 Proposal，不能猜测其他 World 的角色。显式否定、越界目标、
模糊权限和缺失值都不会创建动作。

“查看某角色是否为管理员/当前权限”是只读查询，走
`world.permissions.read`，不会因为疑问句而变成修改动作。一个用户句子最多生成
一个明确的管理 Proposal；组合权限变化仍保留在同一个结构化参数里。

## 执行边界

`propose` 只创建 SkillAction，不执行任何副作用。执行前必须重新检查：

1. World 存在且未归档；
2. 目标角色属于该 World 且未归档；
3. 当前 actor 仍有所需 World Permission；
4. 当前角色、Package Instance、Skill Descriptor、Integration 或模型分配仍然
   与 Proposal 一致；
5. 若是外部副作用，原有 Approval Gate 仍然允许该动作。

管理动作的结果只返回事实摘要，例如“世界设置已更新（revision 3）”或“当前世界
共有 3 个可用角色”。不会把密钥、原始参数、完整设置文件或工具结果写入聊天和
持久化轨迹。

## Settings 与 Model Authority

`settings.json` 是 WorldSettings File Authority。更新使用 `revision` 和
compare-and-set：客户端必须带上读取到的 `expectedRevision`，冲突返回 409，
不会静默覆盖另一个编辑者的设置。管理 Adapter 只提交白名单字段的局部 Patch，
并在写入后读取校验。

世界模型身份不再由 `settings.json` 的 `defaultModelProfileId` 作为权威。模型
分配通过 SQLite `model_assignments` 保存；设置文件只保存推理偏好等运行时偏好。
这样自然语言管理、Settings UI 和重启恢复读取同一份模型分配事实。

## Permission 与 WorkTurn

如果角色缺少 Descriptor 要求的 World Permission，Runtime 创建一个精确绑定当前
`workTurnId`、`skillActionId`、`employeeId` 和 `permission` 的
`WorldPermissionRequest`，随后 WorkTurn 进入等待状态。请求批准后继续同一 WorkTurn，
创建新的 AgentRun 生成最终答复；不会从头重新执行用户消息。

- `once`：只对当前动作有效，动作结束后消费；
- `persistent`：先原子写入 WorldCharacterAuthority，再推进请求状态；
- `reject` / `expired`：不调用 Adapter，生成明确事实结果；
- 服务重启：只根据持久状态、安全 claim 和当前权限重建等待状态，不猜测外部请求
  是否已经发出。

World Permission Request 不能绕过 Approval Request。MCP 默认仍然禁止持久授权，
Firecrawl/HA 的精确目标策略继续由各自 Descriptor 和 Approval Policy 控制。

## 宿主端口

Adapter 不直接依赖 HTTP 或 SQLite 具体实现，宿主只提供最小端口：

- `listCharacters(worldId)`；
- `settings.getSnapshot/savePatch`；
- `authority.get/hasPermission/updateAuthority`；
- Package Instance、model assignment、world rename 和角色更新操作；
- 当前 World 与管理 actor 解析。

生产宿主在 Server composition 中注册单个 Adapter，并将其接到既有
`CharacterSkillRuntime`。测试可以用内存端口验证 parser、preflight、权限拒绝和
结果摘要，而不用伪造外部供应商。

## 相关测试

- `packages/server/tests/world-management-intent-parser.test.ts`
- `packages/server/tests/world-permission-request-service.test.ts`
- `packages/server/tests/world-settings-cas.test.ts`
- `packages/server/tests/world-character-authority-service.test.ts`
- `e2e/world-administrator-authority.spec.ts`

最终合并门禁还包括完整 `pnpm test:e2e`，并在 1440×900、1920×1080、3840×2160
检查权限 Badge、角色权限编辑器、World Settings 与右侧 Dock 没有黑边或大段空白。
