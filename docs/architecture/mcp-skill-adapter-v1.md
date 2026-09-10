# MCP Skill Adapter V1

MCP 在 DSH Cyber 中是受信任 Skill Adapter 的传输协议，不是新的权限系统，也不会直接注册到 Agent loop。

## 执行链路

```text
MCP tools/list
  → CharacterSkillDescriptor
  → 世界内角色的 Skill Grant
  → CharacterSkillAction Proposal
  → Approval Gate / 单次审批
  → SQLite Action Ledger
  → McpSkillAdapter.execute
  → MCP tools/call
```

V1 使用官方 TypeScript SDK 的 Streamable HTTP 客户端。公网地址必须使用 HTTPS；本机和私有网络可以使用 HTTP。stdio 会启动本地可执行程序，属于未来 Extension Host 的权限边界，本阶段不开放。

## 安全边界

- MCP 服务只能提供工具目录和执行传输，不能授予角色权限。
- 每个发现到的工具映射为独立 Skill ID；未获得该 Skill Grant 的角色不能产生动作。
- 所有 MCP 调用按外部动作处理，并以「服务标识 + 工具名」作为精确审批目标（技能 ID 形如 `mcp.<服务>.<工具>`）。一个工作区可配置多个 MCP 服务，服务标识在该工作区内唯一。
- MCP 动态工具只允许单次审批。在具备参数约束和策略指纹之前，不创建角色级或世界级永久策略。
- 原始工具参数在审批期间使用本机 AES-256-GCM 加密保存；Action Ledger 只保留工具名、参数字段名和加密引用。
- 审批拒绝、过期、重复预留或执行结束后销毁加密参数；异常遗留最多保留 24 小时并在下次启动清理。
- 原始工具结果不写入 SQLite、轨迹或日志。Action Ledger 只保存内容块类型、数量和结构化字段名组成的安全摘要。
- MCP 连接凭据继续由 Integration Secret Vault 保存，API 和设置界面不回显明文。

## V1 使用方式

在“连接中心 → MCP 连接”中为一个工作区添加多个 MCP 服务：每个服务填写「服务标识」（小写短标识）与 Streamable HTTP 地址，再测试连接；同一工作区内服务标识必须唯一。连接成功后，每个服务的工具按「服务标识」命名空间映射为独立技能 `mcp.<服务>.<工具>`，角色需要按服务显式获得对应 Skill。用户通过以下形式提出明确调用：

```text
/mcp github.create_issue {"title":"问题标题"}   # 目标形式：<服务>.<工具>，服务 github、工具 create_issue
/mcp create_issue {"title":"问题标题"}          # 省略形式：仅当该角色被授权的服务里只有一个 create_issue 时生效
```

目标形式以第一个点拆分「服务 / 工具」（服务标识不含点，工具名可含点）；当多个被授权服务暴露同名工具时，省略形式视为歧义，必须改用目标形式。命令只创建待审批动作；审批通过前不会建立执行调用。未来 Agent 原生结构化工具调用会复用同一条 Grant、Approval 和 Ledger 链路，不新增旁路。
