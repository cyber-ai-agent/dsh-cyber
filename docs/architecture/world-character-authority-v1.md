# World Character Authority V1

> **已被 ADR 0007 取代。** 本文只记录旧开发快照的兼容模型。当前产品不再创建或
> 展示世界管理员，也不再用 World Authority 决定角色运行权限；请以
> `docs/adr/0007-role-runtime-permissions.md` 为准。

## 目的

World Character Authority 把“这个角色在当前世界能做什么”从 Persona 文本和
Skill Grant 中分离出来，形成一个只对单个 World 生效的持久化授权域。

它解决的是世界内治理问题，不是应用账号体系。一个世界可以拥有多个管理员；
管理员身份、具体权限、运行时文件能力和外部动作审批仍然是四个不同的边界。

```text
WorldCharacterAuthority
├─ WorldCharacterRole
├─ WorldCharacterPermission[]
├─ append-only audit ledger
└─ WorldPermissionRequest

EmployeeRevision.skillGrants       = 角色拥有的 Skill
EmployeeRevision.capabilityGrants  = Harness / Runtime 兼容能力
AgentPermissionMode                = 当前 Agent 的文件系统沙箱
ApprovalRequest                    = 外部副作用的逐动作审批
```

## 权威与隔离

SQLite 是角色世界权限、权限变更审计和一次性权限请求的 Authority。`settings.json`
只负责当前世界的世界观、场景、外观、称呼、推理偏好和运行时偏好；它不负责角色
管理员列表，也不承载模型分配。

所有 authority 行都绑定 `(worldId, employeeId)`，存储层同时校验角色的世界归属。
跨 World 查询、修改、归档和运行时能力解析均拒绝；前端的角色名称、Persona、
模板名称和角色所在位置都不是授权来源。

已有世界在迁移时会生成至少一名活动管理员：优先使用兼容的既有管理员指针，
再使用管家或最早的活动角色。首个新招募角色会成为该世界的管理员，后续角色
默认为普通成员并获得最小的文件读取权限。

## 角色与权限

角色只有两种 World-scoped role：`member` 和 `administrator`。角色是身份投影，
权限集合才是实际授权。系统使用一套共享的 `WorldCharacterPermission` 词汇，
包括文件、设置、角色、扩展、模型、审计和会话元数据/内容权限。

管理员提升可使用 `RECOMMENDED_ADMIN_PERMISSIONS` 预设。预设允许当前世界的
常规管理、文件读写和审计读取，但不自动授予 `danger-full-access`，也不自动授予
Integration Secret 读取或跨 World 能力。角色被降为成员时，管理类权限会被移除。

`world.permissions.manage` 是委托边界：员工管理员只能委托自己拥有的权限，
不能修改自己的身份或权限；本地所有者可以管理当前世界。任何修改都要求非空
原因，并追加一条审计事实。

最后管理员不变量由服务端和存储层共同保护：

- 不能把当前世界唯一管理员降级；
- 不能归档当前世界唯一管理员；
- 必须先提升另一个活动角色，再移交或撤销原管理员；
- 管理员数量可以是 `1..N`，不是单管理员字段。

## 持久化模型

Authority 迁移与现有数据库版本保持同一版本线。核心表为：

- `world_character_authorities`：当前角色的 World role 与权限集合；
- `world_authority_changes`：append-only 变更审计，记录 actor、前后 role、增删权限、
  原因和时间；
- `world_permission_requests`：一个缺失权限请求绑定一个 `workTurnId`、
  `skillActionId`、角色和权限，支持 `pending / approved / rejected / expired`；
- `model_assignments`：当前世界模型分配的 SQLite Authority。

Authority 更新使用 compare-and-set/单事务提交，避免当前权限行、审计行和领域事件
只写入其中一部分。权限请求的持久授予先重新校验角色和权限边界，再以一次性决策
完成；`once` 决策不会改变长期权限。

## HTTP 合同

当前世界的权限 API 只接受当前 World 的角色：

```text
GET  /api/worlds/:worldId/authorities
GET  /api/worlds/:worldId/authorities/:employeeId
PUT  /api/worlds/:worldId/authorities/:employeeId
GET  /api/worlds/:worldId/permission-requests
GET  /api/worlds/:worldId/pending-decisions
POST /api/world-permission-requests/:requestId/decision
```

`PUT` 请求包含 `role`、`permissionGrants` 和用户可理解的 `reason`。权限变更和
决策都经过世界解锁检查；没有跨 World 的全局管理员接口。

`pending-decisions` 是待处理审批和待处理 World Permission Request 的统一读取面，
供工作台进行一次轮询。它不会读取原始 Prompt、密钥、Cookie、完整工具参数或
完整工具结果。

## WorkTurn 与权限申请

自然语言世界管理动作由 `builtin.world-management` 受信任 Adapter 解析和执行，
但仍然进入现有生命周期：

```text
WorkSession
  → WorkTurn
    → SkillAction
      → WorldPermissionRequest（缺少 World Permission 时）
      → Approval / decision
      → durable execution claim
      → WorldManagementAdapter
      → AgentRun continuation
```

等待权限时不占用 DSH Worker；批准后继续原来的 WorkTurn，不重放整个用户回合。
拒绝或过期不会调用管理 Adapter，而是在同一 WorkTurn 中生成简短事实结果。
外部副作用仍由原有 Approval Gate 管理；World Permission 不是另一套 Approval
Policy，也不会替代 MCP、Firecrawl 或 Home Assistant 的逐动作审批。

## 运行时文件能力

`WorldRuntimePermissionResolver` 根据当前 World authority 的
`world.files.read / world.files.write` 派生 DSH 运行时能力：

- 没有文件读取权限时不能通过 World authority 获得文件能力；
- 有读取、没有写入时为 `read-only`；
- 有写入时最多为当前世界 `workspace-write`，工作目录固定在该 World 的
  `worlds/<worldId>/files`；
- 任何角色和 Prompt 都不能把它升级为 `danger-full-access`。

这条边界只影响当前 World 的 Agent Runtime，不改变角色的 Skill Grant，也不代表
角色可以读取 Integration Secret、其他 World 或应用凭据目录。

## 前端投影

工作台在以下位置复用同一 authority 投影：

- 头像与 Pixi 世界角色上的管理员 Badge；
- 会话标题和角色档案中的管理员状态；
- 角色管理编辑器中的 role、权限矩阵、推荐预设和变更原因；
- World Settings 中的管理员概览和进入角色权限编辑器的入口；
- Chat 内的即时权限申请卡，支持本次允许、长期授予和拒绝；
- 统一待处理决策轮询。

左侧会话列表仍然只展示会话，不新增独立管理员列表。权限编辑器只编辑当前
角色的 World authority，不把 Skill Grant 或 Runtime Capability 混入其中。

## 安全与审计边界

World Administrator 不等于 Application Administrator，也不等于 Approval Reviewer。
权限请求不能批准角色自己的权限提升，员工不能跨 World 委托，最后管理员不能被
静默移除。审计记录保存结构化身份和结果，不保存 API key、Authorization、Cookie、
密码、完整 Prompt、原始工具输入/结果或敏感文件内容。

## 验收

合并前必须通过：

1. authority 合同、SQLite 迁移和服务端反向测试；
2. 多管理员、最后管理员、跨 World、员工委托和自我提升测试；
3. 权限请求的同一 WorkTurn、拒绝/过期不执行、重启恢复和 exactly-once 测试；
4. 设置 revision 冲突、模型分配 SQLite 权威和运行时文件能力测试；
5. Chromium E2E：管理员徽章、权限编辑器、即时权限卡、世界隔离和单一待处理
   决策请求；
6. `pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm test:e2e`。

相关实现：

- `packages/contracts/src/world-authority.ts`
- `packages/persistence/src/world-character-authority-repository.ts`
- `packages/server/src/services/world-character-authority-service.ts`
- `packages/server/src/services/world-permission-request-service.ts`
- `packages/server/src/services/world-management-intent-parser.ts`
- `packages/server/src/skills/world-management-adapter.ts`
- `packages/server/src/services/world-runtime-permission-resolver.ts`
- `packages/server/src/routes/world-authority-routes.ts`


## 权限变更语义（V2 稳定化）

权限操作是**增量 patch**，不是整体替换：

| 操作 | 身份 | 权限 |
|---|---|---|
| `grant` | 不变 | 在现有基础上新增 |
| `revoke` | 不变 | 只移除指定项 |
| `promote` | → administrator | 现有 ∪ 推荐管理员集 ∪ 显式新增 |
| `demote` | → member | 保留成员可持有的授权，去掉管理类 |

自然语言解析器只产出 operation，**永不产出 role**。此前「给老王世界设置权限」会带上 `role: 'member'`，把管理员降级并清空全部授权——一句只谈权限的话改变了身份。

给普通成员授予管理类权限返回结构化拒绝（`requires_administrator_promotion`，HTTP 409）并列出被拒的权限，由调用方决定「设为管理员并授予」还是取消。此前是静默过滤，而且 added/removed 在过滤之后计算，所以审计账本记录的是一次成功的较小授权，看不出发生过拒绝。

## 决策审计保留

`world_permission_requests.work_turn_id` 从 `NOT NULL … ON DELETE CASCADE` 改为可空 + `ON DELETE SET NULL`（migration 22），并持久化 `session_id`。

已结束的 WorkTurn 是可清理的运行遥测；**授权决策不是**。`skill_action_id` 仍是硬 CASCADE —— 一条决策绝不能比它授权的那个确切执行事实活得更久。

## 文件访问

```text
none  → 空的受管工作区（cache/restricted-workspace），read-only
read  → 真实 worlds/<id>/files，read-only
write → 真实 worlds/<id>/files，workspace-write
```

此前无论有没有 `world.files.read`，运行时拿到的都是同一个真实目录和 read-only 模式——这个权限在运行时没有任何效果。workspace seam 因此改为按角色解析而不是按世界。

管理员权限本身永远不会解析成 `danger-full-access`。
