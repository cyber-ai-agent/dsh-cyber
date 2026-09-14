# Skill Catalog 与 Integration Registry V1

本阶段把角色能力拆成两种不会混淆的宿主边界。

## Skill Recipe

Skill Recipe 是经过宿主审核的声明式工作方法，只包含名称、用途和按需加载的说明。它没有执行回调、系统命令、网络连接或凭据。

当前内置目录覆盖世界配置、会话整理、会议纪要、任务协调、软件实现、测试验证、档案整理、知识检索、证据总结、叙事创作、编辑审校、内容制作、科学推理和系统诊断。

角色 Blueprint 只声明 `requestedSkills`。创建角色时，界面默认勾选安全 Recipe，用户可以取消；需要外部连接的 Skill 不会默认授权。运行时只把当前 revision 已授权的 Recipe 注入角色设定，不会加载完整目录。

## 技能中心与引用模型

顶部“技能中心”是当前世界的 Skill 汇总入口。它读取工作区 Skill Catalog 与当前世界的 World Package Instance，展示内置技能、技能包和 MCP 动态技能，并完成两类引用操作：

- “加载到当前世界”创建一个 World Package Instance，世界持有包 ID 与版本引用；技能定义仍保留在唯一安装源中。
- “引用到角色”写入角色 revision 的 `skillGrants`，角色只保存 Skill ID；Skill 定义、说明和后续兼容更新继续来自 Catalog。

角色设置中的“技能”只处理 Skill 引用。连接凭据与连接选择进入“权限 → 连接权限”，两类状态各自保存、在执行边界同时校验。

### 管理中心结构

技能中心沿用模型中心与连接中心的统一外壳，并保留可扩展的顶层栏目：

- **技能列表**：按来源查看全部技能；选择技能后展示软件包文件树和有界文本内容。内置、官方和连接发现技能保持只读；技能中心生成的技能通过“编辑技能”发布不可变新版本。
- **技能设置**：左侧选择全局或任一世界，右侧勾选 Skill；支持全部勾选。全局设置是各世界的默认集合，世界可以保存精确覆盖或恢复跟随全局。
- **添加技能**：导入普通 `kind=skill` 软件包，或用默认模型把自然语言工作方法撰写/优化为声明式 Skill Recipe。

技能范围保存在 SQLite `skill_scope_settings`。范围只保存 Skill ID 数组；Skill 定义、说明与文件仍来自宿主 Registry 或已安装包。旧数据缺少范围记录时继续采用原有可用集合，首次保存后进入显式范围模式。

用户撰写的 Recipe 固定使用 `integrationId=builtin.recipe`、空 `dataEgress` 和 `skill:recipe` 包能力。发布产物包含 `skill.json`、`SKILL.md` 和来源审计文件；编辑会递增补丁版本并经过 PackageManager 预览、安装、世界实例化与回退边界。模型只生成待审草稿，包 ID、版本、能力、入口路径和数据外发声明由宿主确定。

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
  → World Package Instance / builtin catalog reference
  → Character revision Skill Grant
  → Character revision Connection Grant (连接型 Skill)
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

连接中心（连接级，多连接类型见 [connection-hub-v1](./connection-hub-v1.md)）：

- `GET /api/workspaces/:workspaceId/integrations`
- `PUT /api/workspaces/:workspaceId/integrations/:integrationId/connections/:connectionId`
- `DELETE /api/workspaces/:workspaceId/integrations/:integrationId/connections/:connectionId`
- `POST /api/workspaces/:workspaceId/integrations/:integrationId/test?connectionId=`
- 兼容保留类型级 `PUT/DELETE .../integrations/:integrationId`

API 不返回凭据明文，只返回 `credentialConfigured`。
