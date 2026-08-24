# Skill Catalog 与 Integration Registry V1

本阶段把角色能力拆成两种不会混淆的宿主边界。

## Skill Recipe

Skill Recipe 是经过宿主审核的声明式工作方法，只包含名称、用途和按需加载的说明。它没有执行回调、系统命令、网络连接或凭据。

当前内置目录覆盖世界配置、会话整理、会议纪要、任务协调、软件实现、测试验证、档案整理、知识检索、证据总结、叙事创作、编辑审校、内容制作、科学推理和系统诊断。

角色 Blueprint 只声明 `requestedSkills`。创建角色时，界面默认勾选安全 Recipe，用户可以取消；需要外部连接的 Skill 不会默认授权。运行时只把当前 revision 已授权的 Recipe 注入角色设定，不会加载完整目录。

这一设计参考了开放 Agent Skills 生态的渐进加载方式，包括 [OpenAI Skills](https://github.com/openai/skills)、[Anthropic Skills](https://github.com/anthropics/skills) 和 [Microsoft Agent Skills](https://github.com/microsoft/skills)。DSH Cyber 只吸收可移植的声明式结构，不直接执行第三方 Skill 中携带的脚本。

## Integration Registry

Integration Registry 是 Firecrawl、Home Assistant、GitHub 和未来 MCP Transport 的共同宿主注册层。Provider 通过稳定接口声明：

- 公开配置字段
- 凭据字段
- 提供的 Skill ID
- 会发送到外部服务的数据类别
- 配置校验
- 连接测试

公开连接配置保存在 `stateRoot/integrations`，并进入完整本地 Backup Bundle。凭据保存在独立的 AES-256-GCM 本机凭据库，不进入连接配置、SQLite、HTTP 响应、日志、Prompt 或动作记录。

## 执行链

```text
Blueprint requested Skill
  → Character revision Skill Grant
  → CharacterSkillRuntime proposal
  → durable Skill Action
  → Approval Request or exact Policy
  → Integration Registry
  → trusted Adapter
  → durable safe result
```

Marketplace 包只能安装声明式 Skill Recipe。Provider Adapter 由受信任宿主注册，第三方包无法获得 Adapter 实例。

## Firecrawl 验收样例

`web.search.firecrawl` 用于验证通用链路。只有当前世界已实例化联网搜索 Skill Recipe、用户明确要求联网搜索、角色持有对应 Grant、审批已通过且连接已启用时，Adapter 才调用 Firecrawl `POST /v2/search`。查询文本属于 Data Egress，设置界面会明确展示。

结果只保留有限数量的公开标题、URL 和摘要，不保存网页全文、原始响应或凭据。API 失败、限流、额度不足和超时会转换为可读状态，不伪造搜索成功。

本阶段不会把 MCP Tool 直接注册进 Agent Runtime。MCP 将在下一阶段作为 `CharacterSkillAdapter` Transport 接入，并继续经过 Grant、Approval 和 Action Ledger。

## 本地 API

- `GET /api/workspaces/:workspaceId/integrations`
- `PUT /api/workspaces/:workspaceId/integrations/:integrationId`
- `POST /api/workspaces/:workspaceId/integrations/:integrationId/test`
- `DELETE /api/workspaces/:workspaceId/integrations/:integrationId`

API 不返回凭据明文，只返回 `credentialConfigured`。
