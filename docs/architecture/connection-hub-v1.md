# 连接中心与两级授权 V1

顶部工具栏“连接中心”统一管理会对外产生动作的受信任连接（SSH 设备，未来扩展到 API Token 服务等）。它不是一个独立子系统，而是把原来的 Integration Registry 演进为“一个宿主、多连接实例”的授权中心，SSH 只是其中一种连接类型。

## 产品位置与信息架构

- 顶部工具栏在“模型中心”之后、系统状态之前增加“连接中心”入口（`ConnectionHubLauncher` → `ConnectionHubDialog`）。
- 原“设置 → 外部连接”被并入连接中心（`IntegrationSettingsPanel` 共享组件，设置面板与顶栏对话框复用同一实现）。
- 每个连接类型（Provider）可以持有多个连接实例；当前只有 SSH 设备声明 `allowsMultipleConnections`，单连接类型保持旧的一类型一连接流程。

## 角色两级授权（Skill + Connection）

角色的“技能与工具”只决定“能做什么”，不决定“能用哪台设备”。执行外部动作必须同时满足：

1. **技能授权**：角色当前 revision 的 `skillGrants` 包含该技能（如 `device.ssh.command`），且世界 Skill Catalog 可用；
2. **连接授权**：角色当前 revision 的 `connectionGrants` 包含目标连接 id（如具体某台 SSH 设备）。

```text
Character revision
  ├─ skillGrants:      ['device.ssh.command']  能做什么
  └─ connectionGrants: ['builtin.ssh-device:<id>']  能用哪台设备
```

`connectionGrants` 为空或缺失即默认拒绝所有设备——即使技能已授权也不会外发任何命令。这是可复用审批收敛策略的一部分：禁止“装了插件/角色要过技能就默认放行所有连接”的宽泛授权。

### 执行边界

- `SshSkillAdapter.preflight` 先解析目标连接，再检查该连接是否在 `connectionGrantsFor(characterId)` 中；不在即 `ready:false`。
- `SshSkillAdapter.execute` 在真正连接前再次执行同一检查，未授权返回 `failed`，不发送任何命令。
- 未提供 grants 解析器（例如旧测试或独立嵌入方构造 Adapter 时）默认全部拒绝，安全失败。
- 连接 id 从连接中心解析（按名称或主机匹配），删除的连接即使残留授权 id 也不会再生效。

## 持久化与迁移

- 角色 revision 新增 `connectionGrants: string[]`（`employee_revisions.connection_grants_json`，默认 `[]`）。
- 数据库 schema v52 `employee-connection-grants`：`ALTER TABLE employee_revisions ADD COLUMN connection_grants_json TEXT NOT NULL DEFAULT '[]'`。
- 招募初始 revision 写入空数组；revise 可整体替换连接授权，缺省沿用上一版；重复 id 被拒绝。
- `PUT /api/employees/:employeeId/revisions` 接受 `connectionGrants: string[]`。
- 连接凭据仍只保存在 `stateRoot/integrations` 的本机 AES-256-GCM 凭据库，不进 SQLite、HTTP 响应、日志、Prompt 或动作记录。

## 角色设置 UI

角色设置 → 技能与工具 → 连接授权（`ConnectionGrantEditor`）：

- 列出当前工作区可勾选的设备连接（多连接且带 skillIds 的类型），显示设备名、地址与状态（已停用 / 缺少凭据 / 已授权 / 可授权）。
- 勾选/取消即写入本地 revision 草稿；任一保存动作都会把当前连接授权随 revision 一起持久化。
- 已在连接中心删除的连接会显示在“已移除的连接”，供显式清理历史授权。

## SSH 设备操作（M1–M2 验收）

`device.ssh.command` 技能由宿主受信任的 `builtin.ssh-device` Adapter 提供，proposal 由意图解析器（`ssh-command-parser`）产出，不把自由 shell 文本交给模型生成。

- 允许操作是白名单集合：`system.info`、`disk.usage`、`memory.usage`、`process.list`、`service.restart`、`package.list`、`package.install`、`file.list`。
- 私钥只在宿主机内存中用于一次 ssh2 会话，绝不落盘、不进动作记录。
- 每个动作的最终执行状态写入 Skill Action Ledger；失败原因映射为可读中文（认证失败/不可达为 failed，超时/断流为 outcome-unknown，禁止自动重试）。
- 世界轨迹通过通用 `SkillActionTraceAdapter` 投影每次 SSH 动作：只暴露摘要、状态与限长结果片段，不带结构化参数、私钥或原始 payload，与其它外部 Skill 共用同一脱敏边界。

## 本地 API

连接中心（连接级）：

- `GET /api/workspaces/:workspaceId/integrations`
- `PUT /api/workspaces/:workspaceId/integrations/:integrationId/connections/:connectionId`
- `DELETE /api/workspaces/:workspaceId/integrations/:integrationId/connections/:connectionId`
- `POST /api/workspaces/:workspaceId/integrations/:integrationId/test?connectionId=`
- 兼容保留类型级 `PUT/DELETE .../integrations/:integrationId`

角色连接授权：

- `PUT /api/employees/:employeeId/revisions`（body 携带 `connectionGrants`）
- `GET /api/employees/:employeeId/dossier`（返回 revision 含 `connectionGrants`）

API 不返回凭据明文，只返回 `credentialConfigured`。
