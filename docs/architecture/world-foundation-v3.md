# World Foundation V3

DSH Cyber 的产品主实体从“公司工作区”提升为“本地世界”。Workspace 暂时保留为数据库兼容层和全局模型/扩展容器，但不再作为主 UI 概念。

每个世界拥有独立的 <stateRoot>/worlds/<worldId>/files、assets、exports 与 cache 目录。Agent 回合只能获得当前世界的 files 根路径。世界设置保存在该世界自己的 settings.json，访问锁保存在同一世界根目录的 .access.json，密码只保存 scrypt 派生结果。

产品文案统一使用“角色”。现有 Employee* TypeScript/SQLite/package-v1 标识继续作为兼容合同存在，并提供 Character* 类型别名；后续 schema major 再迁移物理表名与包 kind，避免破坏社区扩展。

DSH runtime 升级到 0.1.0-rc.8，并把 rc.8 的按模型 reasoningEfforts / compat.thinkingFormat 边界接入模型路由。会话可传入推理档位；auto 表示不向上游强制推理档位。
