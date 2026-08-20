# 员工蓝图创作约定

员工蓝图是可招聘员工实例的声明式模板，不是员工本身。招聘后生成独立 employee、revision 和 Agent session；后续档案、技能证据、模型分配和状态属于实例，不能回写或污染蓝图。

## 包和入口

蓝图包位于 `marketplace/talent/<package-id>`，但清单 MUST 使用：

- `kind: "employee-blueprint"`；
- 恰好一个 `entrypoints[].kind: "employee-blueprint"`；
- `capabilities` 包含 `employee:blueprint`，并覆盖蓝图请求的每项能力；
- `dataEgress: []`；
- entrypoint 路径出现在 `files` 中；
- 最小、真实的 `capabilities` 与 `dataEgress`。

`talent` 仅是市场分类。把 package kind 写成 `talent` 会被拒绝。

## 当前蓝图 Schema

entrypoint 必须是一个蓝图对象，不能用数组在一个包中混装多份身份。严格 parser 只接受以下字段：

```json
{
  "schemaVersion": 1,
  "id": "community-archivist",
  "version": 1,
  "worldTemplateId": "cyber-company",
  "displayName": "档案管理员",
  "role": "知识与档案管理员",
  "summary": "整理可追溯的历史和交付记录。",
  "persona": "只陈述有来源的事实，并明确区分推断。",
  "requestedSkills": ["archive-curation"],
  "requestedCapabilities": ["workspace:read"],
  "createdAt": "2026-08-20T00:00:00.000Z"
}
```

要求：

- `schemaVersion` MUST 为 `1`，未知字段会被拒绝；
- `id` MUST 与 package id 完全相同；包版本是分发身份，蓝图整数版本是员工实例引用的不可变身份；
- `version` MUST 是大于等于 1 的整数；
- displayName/role/summary/persona 分别不超过 50/100/500/2000 个字符；
- 技能和能力数组各不超过 64 项，格式必须合法且不能重复；
- 每项 `requestedCapabilities` MUST 同时出现在包清单 `capabilities` 中；
- `createdAt` MUST 是 canonical ISO 8601 时间；
- `worldTemplateId` MUST 与招聘目标世界完全一致；
- `id + version` MUST 代表不可变蓝图版本；
- persona MUST 明确身份、职责、事实边界和禁止冒充其他员工；
- requested 项只是建议/请求，不会自动变成实例授权。

同一 `id + version` 再次写入时只有内容完全一致才可幂等通过；任一语义字段变化都必须提升蓝图整数版本，不能覆盖已经被员工实例引用的历史。

## 当前未支持字段

外部草案中的 avatar、skillFiles、memoryFiles、modelPolicy、personality、constraints、compatibility 和评测文件尚未成为 employee blueprint schema。它们可以在 issue 中作为 ROADMAP 讨论，但不能写进当前包并宣称生效。

这是有意保留的安全边界：模型供应商和模型 id 继续由现有 `ModelProfile`/assignment 管理；技能与记忆文件在没有独立权限、来源证据和运行时隔离机制前不从市场包注入。不能为“字段齐全”绕过现有凭据、会话和能力模型。

员工实例的模型策略、skill grants 和 capability grants 通过招聘/修订流程设置。招聘 UI 会把每项 requested capability 显示为默认未选中的复选框；只有用户明确勾选的子集才写入 revision。后续修订会回显当前 grants，可显式撤销，并且 skill/capability grants 都不能扩大到蓝图未请求的集合。requested skills 在招聘时只展示建议，不会静默授予。长期记忆、跨世界读取和私有会话访问同样不会因蓝图声明自动开放。

## 安全和内容约定

- persona 不得要求绕过系统指令、权限审批或数据隔离；
- 不得嵌入密钥、真实个人信息、私有对话或不可再分发内容；
- 包声明的能力必须覆盖蓝图请求并保持最小；`employee:blueprint` 是入口控制能力，不需要写入蓝图 requested capabilities；
- 同一蓝图可被多次招聘，但每个实例必须保持独立身份和会话；
- 主题视觉与员工业务身份分离，蓝图不得假定某个内置头像路径存在。

## 验证

以 `marketplace/talent/official-archivist` 为当前格式参考。PR MUST 证明：包能被发现和安装、staged 解析失败会回滚、蓝图只在兼容世界的招聘目录出现、至少可招聘两个独立实例、实例会话不串线、重启后实例与 revision 可恢复，以及默认无授权、逐项批准和越权拒绝都符合预期。
