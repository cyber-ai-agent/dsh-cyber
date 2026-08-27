# Creative Workshop V2 与模型路由

## 产品流程

```text
自然语言需求
  → 默认模型生成 CreativeWorkshopDraftV1 JSON
  → 严格 Schema / 安全边界校验
  → 可视化表单审查
  ↔ 高级 JSON 查看、编辑、导入与导出
  → 模型、技能和权限建议检查
  → 创建预览
  → 用户明确确认
  → compile / PackageManager preview
  → 补偿式事务创建 World + Characters
```

AI 只填充草稿，不调用正式创建接口。草稿中的 `requestedSkills` 和 `requestedPermissions` 都是建议，不能变成授权；持久角色 ID、数据库 ID、版本、路径、Provider ID、Package ID 与批准状态只由宿主生成或解析。模型输出无效 JSON、越权字段或不匹配的模型引用时，服务拒绝草稿且不创建任何实体。

## 草稿与持久化

`CreativeWorkshopDraftV1` 是稳定的中间协议。每个角色使用唯一 `tempId`，重复数量必须展开为独立对象。工作区当前草稿保存在 `stateRoot/workshop/drafts`，编辑采用 600ms debounce 自动保存，组件卸载时 flush；成功创建后清除草稿。程序更新与重新构建不触碰该目录，Backup Bundle 继续覆盖整个 `workshop/`。

可视化表单是唯一 Draft State。JSON 编辑器每次从表单状态派生，点击“应用到草稿”后重新解析和校验，再写回同一状态，不维护第二份漂移数据。

## 最小创建与渐进展开

- 世界最少只需名称。
- 角色最少只需名字。
- 身份、职责、Persona、具身语义和能力建议均可在折叠区补充或创建后完善。
- 编译前宿主补齐安全默认值；这不改变“AI 建议不是授权”的边界。

## 模型解析

```text
Conversation temporary override
  → Character assignment
  → World assignment
  → Workspace assignment
  → Application default
```

统一 `ModelPicker` 先选供应商再选模型，支持供应商名、模型名、模型 ID 和可信能力元数据搜索。角色和世界只保存 `modelProfileId` 引用，不复制 API Key、Base URL 或 Provider 配置。对话临时选择只进入该回合的持久消息元数据，不修改长期分配；队列恢复后仍使用原回合选择。

模型发现与 AI 草稿请求共用 URL 安全策略：公网只允许 HTTPS，拒绝 URL 用户信息、云元数据、链路本地、私网或保留目标，公网域名在发出凭据前检查 DNS，且禁止重定向。

## 会话输入安全

普通消息在 HTTP 边界做 NFC 规范化、Unicode 字符计数与 C0/C1 控制字符拒绝；换行、Tab、emoji、中日韩与 RTL 文本保持可用。不会用关键词过滤“忽略指令”等自然语言。历史消息使用结构化 JSON 编码，用户内容和外部资料始终是低于宿主策略的“不可信数据”，不能伪造消息边界。

## 失败与回滚

正式创建只在最终确认后开始。全部角色、Manifest 和 PackageManager preview 先完成，随后才变更世界。任何一步失败都会反向补偿世界目录、世界记录、Blueprint 和可逆包安装；测试必须确认失败时没有半个世界或部分角色。
