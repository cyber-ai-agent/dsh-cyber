# 创作规范实现状态

本表只描述仓库当前可执行能力。`packages/server/tests/marketplace-conformance.test.ts` 把仓库内市场包的目录可发现性、类型/入口/能力一致性和三类 entrypoint schema 纳入持续测试。

## 结论

世界主题、本地包、员工蓝图和 prompt-transform 已收敛到严格声明式边界；现有领域模型更安全的部分继续保留。远程市场、发布 CLI、密码学签名、依赖解析、任意插件代码和外发监控仍未实现，不能通过文档字段假装存在。

会话连续性支持同一会话跨重启恢复，回合与角色执行生命周期也已持久化到本地 SQLite。当前能力不包含跨会话语义检索、情景记忆、向量检索和自动记忆整理。

| 领域 | 已实现 | 部分实现/约定补强 | 未实现（ROADMAP） |
| --- | --- | --- | --- |
| 包审批 | 完整 manifest 内容绑定、加密随机 token、TTL、单次消费、活动版本绑定、失败回滚 | grant 存于进程内，重启后需重新 preview | 跨设备/远程审批 |
| 包完整性 | 严格 manifest、未知字段/长度/唯一性、入口-类型-能力关系、完整源目录库存、逐文件 SHA-256、路径/symlink 防护、staged 入口校验、激活后目标文件复验 | license 当前做 SPDX 表达式语法校验，不内置完整注册表 | 密码学签名、透明日志 |
| 本地市场 | themes/plugins/talent 独立目录、搜索、官方 authority + digest、本地安装 | `certification` 不是签名；`verified` 级别不存在 | 远程 index、publish、付费、依赖、更新、卸载 |
| 世界包实例 | 市场目录、工作区只读包库和世界私有实例分层；固定包版本与内容摘要；`origin`、`overrides` 和 SQLite 身份归属世界；Prompt、主题资源和角色蓝图只从当前世界实例进入运行时；创建失败精确补偿 | 主题绑定会显式创建世界实例；同版本请求幂等；不同版本拒绝隐式覆盖；**「蓝图只有在世界存在实例时才可招募」在目录与运行时路径强制，但 `POST /api/worlds/:id/recruit` 仍会回退到工作区全局蓝图** | 带差异预览的更新、rebase、三方合并、overrides 编辑器 |
| 世界主题 | 严格 nested/JSON parser、资源限制、引用/唯一性、八项核心 activity mapping、极端导航拒绝、安装/绑定/切换/禁用/内置回退 | 当前正式官方 roster 多数状态使用受控单帧 fallback | 音频、多场景切换、Three renderer |
| 主题身份 | package + packageVersion + theme + themeVersion + digest，renderer key 不冲突 | 内置主题使用专用 builtin identity | 签名内容寻址分发 |
| 主题资产 | staged 时整包与逐资产验证、`assets/` 包内路径、PNG/JPEG/WebP 签名、4/8 MiB 上限、不可变身份缓存、请求目标文件复验、越界/symlink 拒绝 | 缓存为进程内可信缓存 | 远程内容存储/CDN（当前明确禁止） |
| Pixi 表现 | RendererRegistry、Pixi 实现、8 状态、四向 fallback、脚底锚点、Y-sort、遮挡、growth badge | 官方 roster 多数 clip 目前是单帧受控 fallback | Three.js、正式多帧全方向资产 |
| 员工蓝图 | schemaVersion、严格字段/长度/唯一性、package id 与能力绑定、不可变 id+version、模板过滤、默认拒绝与逐项能力授权、独立实例/会话、SQLite 恢复 | requested skills 当前展示但不自动授权；模型继续走 ModelProfile/assignment | avatar、memory/skill 文件、蓝图 modelPolicy、compatibility/评测 schema |
| 插件 | canonical `prompt-transform` 进入真实 conversation runtime prompt；legacy `commands` 明确转换；staged 校验；原始用户消息持久化不被改写 | 仅声明式 JSON；支持 `/command`、`always`、prepend/append/replace、priority 与资源上限；强制无外发 | 可执行代码、skill/tool/event/widget、网络代理与外发审计 |
| 会话记忆 | 单个 WorkSession 的用户可见聊天历史由本地 SQLite 恢复：跨进程重启、Harness Runtime 重建、权限模式切换和 persisted-log 碰撞轮换都能继续对话；私聊/群聊/世界之间严格隔离；群聊历史保留真实发言人；reasoning、tool-call、tool-result、system、临时气泡与凭据不进入历史 | 预算为「24 条 + 16000 字符」的确定性截断，不使用 tokenizer；超长单条消息截断并标注；每个角色按自身 watermark 增量补齐——新 Session 重播全部，存活 Session 只补它未见过的部分（私聊恒为空，群聊补上一轮晚于自己发言的角色）；同一员工的回合串行、不同员工并行 | Episodic/Semantic/Procedural memory 分类、向量检索、Embedding、自动摘要与记忆整理、跨会话回忆 |
| 会话执行 | `WorkSession → WorkTurn → AgentRun` 持久模型；Skill Action 和 Approval Request 绑定同一会话与回合；`waiting-approval` 不占用 Worker 且跨重启保留；审批完成后在原 WorkTurn 新建 AgentRun，不重放用户回合；群聊和角色协作按真实调用顺序记录多次运行 | 当前只记录生命周期、错误码和 Runtime Session ID，不持久化原始 prompt、工具输入或工具结果 | 通用事件 items 表、远程执行同步 |
| 世界轨迹 | 每个 AgentRun 投影为一条稳定主轨迹；中文判断摘要、结构化工具调度、状态、耗时、模型和真实 Token 归入同一次运行；按角色汇总 Token；支持角色、日期、关键词、内容和状态筛选以及游标分页；实时与重启恢复使用同一身份；全链路脱敏 | Token 只在 Harness 明确返回时展示，不进行估算；旧运行没有 Token 时保持为空 | 跨设备轨迹同步、用户配置的轨迹保留策略 |
| 应用访问锁 | 全局锁屏覆盖整个工作台；锁定状态下服务端拒绝除健康检查和解锁外的应用 API；密码使用 scrypt 派生哈希保存在本机凭据目录；错误尝试限速；服务重启后默认重新锁定 | 会话当前保存在进程内并具有固定有效期；应用锁不代替操作系统账号、磁盘加密或文件权限 | 系统生物识别、设备间锁状态同步 |
| 世界管理员 | 新世界首个角色自动成为管理员；已有世界迁移时优先选择管家，否则选择最早的活动角色；支持同世界内管理员移交；角色运行时只获得当前世界的管理员职责 | 同世界绑定由存储层强制（跨世界指派被拒绝）；管理能力本身目前只是写入 Persona 的身份标记，没有运行时强制点 | 多管理员、细粒度世界管理角色 |
| 设置与模型连接 | 设置内容采用单列信息流；模型连接先配置地址与密钥，再拉取并搜索选择模型 ID；维护页只保留真实应用更新；主题采用完整预设并折叠低频自定义项 | 公开模型目录依赖供应商接口；手动模型 ID 保留为显式备用模式 | 自动供应商账户导入、跨设备设置同步 |
| 应用更新 | 仅支持干净 `main` 分支从 `origin/main` 快进；更新前在隔离工作树完成 frozen install 与 build，并创建完整本地 Backup Bundle | 更新完成后需要用户重启当前进程；非 Git 安装和开发分支会明确显示不支持原因 | 桌面安装包增量更新、签名发布通道 |
| 动作审批 | 外部副作用先持久化 Skill Action 与 Approval Request；两者关联 WorkTurn；未批准、已拒绝、已过期或授权已撤销时不会进入受信任 Adapter；持久执行 CAS 保证单次进入外部边界；审批后崩溃可安全续跑，已进入外部边界的崩溃转为结果未知并禁止自动重试 | 会话内审批卡展示适配器、技能、调用、目标与参数，提供本次允许/一直允许/拒绝，并有一条穿 HTTP 的 propose→approve→execute 回归测试；可复用策略由 Skill Descriptor 显式授权，严格绑定 Skill、Action、Target、Risk 与作用域，**永不绑定 `parameters`**，因此语义装在参数里的技能（Firecrawl、MCP）声明 `forbidden` | 独立审批中心界面、通用文件写入审批、远程审批同步 |
| MCP Skill Adapter | 官方 MCP TypeScript SDK Streamable HTTP 客户端；工具发现映射为独立 Skill；调用严格经过角色 Grant、单次 Approval 和 SQLite Action Ledger；禁止创建角色级或世界级持久策略；参数加密暂存并确定性清理；原始结果不持久化 | V1 通过显式 `/mcp 工具名 JSON` 命令提出调用；每个工作区当前配置一个 MCP 服务 | stdio Extension Host、模型原生结构化调用、多 MCP 服务实例管理 |
| 模型交互日志 | turn/discovery 双源采集、SQLite 持久化、分页/筛选/详情/清空 API、设置面板日志界面、错误信息密钥清洗；v17 将 turn 日志绑定到 WorkTurn 与 AgentRun，并保存 Harness 返回的真实 Token | 一条 turn 日志表示整轮角色运行，不拆分 worker 内部的多次模型请求；消息数为近似统计；无自动保留策略 | worker 内逐请求明细、日志自动清理和条数上限 |
| CI | Node 22.19、pnpm 11.7、frozen lockfile、typecheck、test、Chromium、E2E | 仓库工作流名为 `required`；GitHub 分支保护需在仓库设置中另行确认 | 自动发布与包签名流水线 |

## 关键证据

- 包审批与事务：`packages/package-runtime/src/package-manager.ts`、`packages/package-runtime/tests/package-manager.test.ts`
- 本地市场与完整性：`packages/package-runtime/src/local-package-catalog.ts`、`packages/package-runtime/src/local-package-runtime.ts`
- 世界包实例：`packages/server/src/services/world-package-instance-service.ts`、`packages/persistence/src/migrations.ts`、[世界包实例](../architecture/world-package-instance-v1.md)
- 主题 parser：`packages/world-runtime/src/manifest.ts`、`packages/world-runtime/tests/world-runtime.test.ts`
- 安装入口与资产缓存：`packages/server/src/installed-package-runtime.ts`、`packages/server/src/world-theme-package.ts`、对应 tests
- 社区包门禁：`packages/server/tests/marketplace-conformance.test.ts`
- 主题绑定与资产服务：`packages/server/src/world-runtime-service.ts`
- renderer 与动画：`packages/web/src/features/world/renderer`、`packages/web/tests`
- 员工蓝图解析与实例化：`packages/server/src/employee-blueprint-manifest.ts`、`packages/persistence/src/sqlite-store.ts`
- prompt transform：`packages/server/src/prompt-transform-parser.ts`、`packages/server/src/routes/conversation-routes.ts`
- 会话记忆与执行：`packages/orchestration/src/conversation-history.ts`、`packages/orchestration/src/conversation-orchestrator.ts`、`packages/persistence/src/migrations.ts`、`packages/persistence/src/sqlite-store.ts`、`packages/harness-adapter/src/history-prompt.ts`、`packages/harness-adapter/src/adapter.ts`、`packages/orchestration/tests/conversation-history.test.ts`、`packages/orchestration/tests/conversation-memory.test.ts`、`packages/server/tests/conversation-memory-restart.test.ts`
- 动作审批：`packages/server/src/services/turn-aware-approval-continuation-service.ts`、`packages/server/src/services/character-skill-runtime.ts`、`packages/server/src/skills/sqlite-skill-action-repository.ts`、`packages/persistence/src/migrations.ts`、`packages/persistence/src/sqlite-store.ts`、`packages/server/tests/turn-aware-approval-continuation.test.ts`、`packages/server/tests/character-skill-runtime.test.ts`、[Approval Gate V1](../architecture/approval-gate-v1.md)
- MCP Skill Adapter：`packages/server/src/skills/mcp-skill-adapter.ts`、`packages/server/src/integrations/mcp-client.ts`、`packages/server/tests/mcp-skill-adapter.test.ts`、[MCP Skill Adapter V1](../architecture/mcp-skill-adapter-v1.md)
- 世界轨迹：`packages/server/src/services/world-trace-service.ts`、`packages/server/src/world-trace/agent-run-trace-adapter.ts`、`packages/web/src/components/world-trace/`、[世界轨迹中心](../architecture/world-trace-center-v1.md)
- 应用访问锁：`packages/server/src/services/application-access-service.ts`、`packages/server/src/http/application-access-guard.ts`、`packages/web/src/components/ApplicationLockGate.tsx`
- 世界管理员：`packages/persistence/src/sqlite-store.ts`、`packages/server/src/routes/world-routes.ts`、`packages/server/src/services/character-profile-runtime.ts`
- 设置、创意工坊与更新：`packages/web/src/components/SettingsDialog.tsx`、`packages/web/src/components/creative-workshop/CreativeWorkshopEditor.tsx`、`packages/server/src/services/application-update-service.ts`
- 模型交互日志：`packages/server/src/services/model-interaction-service.ts`、`packages/server/src/routes/model-interaction-routes.ts`、`packages/persistence/src/migrations.ts`（v11）、[模块说明与观测边界](model-interaction-logs.md)
- CI：`.github/workflows/ci.yml`

## 采用规则

讨论稿条款只有满足以下任一条件才能从 ROADMAP 升级为当前约定：

1. 已进入 versioned contract，并有严格解析和兼容策略；
2. 已进入运行时/持久化真实路径，并有正反测试；
3. 作为社区审核政策明确标注“代码未强制”，且不会暗示产品能力。
