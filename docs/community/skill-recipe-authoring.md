# Skill Recipe authoring

Skill Recipe 是世界可安装的声明式能力请求，不是在主进程执行的第三方代码。

包的 `kind` 必须为 `skill`，入口类型必须为 `skill`。入口 JSON 包含以下字段：

- `schemaVersion`
- `id`
- `displayName`
- `summary`
- `integrationId`
- `dataEgress`
- `instructions`

`id` 必须与 manifest 入口 ID 一致。`dataEgress` 描述会发送的数据类别；manifest 的 `dataEgress` 使用明确的 HTTPS 目标地址。`instructions` 只描述使用方法，不能包含凭据、隐藏 Prompt、系统命令或任意可执行代码。

安装包只会把 Recipe 放入当前世界。真实执行仍要求：

1. 宿主注册对应 Integration Adapter。
2. 角色 Blueprint 请求该 Skill。
3. 角色 revision 明确授予该 Skill。
4. Approval Gate 允许具体动作。
5. 外部连接已启用且凭据有效。

缺少任一条件时，宿主不会发送外部请求。第三方包无法取得 Adapter、Secret Vault、系统命令、任意文件或任意网络访问。
