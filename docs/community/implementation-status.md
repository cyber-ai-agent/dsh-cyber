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
| 世界主题 | 严格 nested/JSON parser、资源限制、引用/唯一性、八项核心 activity mapping、极端导航拒绝、安装/绑定/切换/禁用/内置回退 | 当前正式官方 roster 多数状态使用受控单帧 fallback | 音频、多场景切换、Three renderer |
| 主题身份 | package + packageVersion + theme + themeVersion + digest，renderer key 不冲突 | 内置主题使用专用 builtin identity | 签名内容寻址分发 |
| 主题资产 | staged 时整包与逐资产验证、`assets/` 包内路径、PNG/JPEG/WebP 签名、4/8 MiB 上限、不可变身份缓存、请求目标文件复验、越界/symlink 拒绝 | 缓存为进程内可信缓存 | 远程内容存储/CDN（当前明确禁止） |
| Pixi 表现 | RendererRegistry、Pixi 实现、8 状态、四向 fallback、脚底锚点、Y-sort、遮挡、growth badge | 官方 roster 多数 clip 目前是单帧受控 fallback | Three.js、正式多帧全方向资产 |
| 员工蓝图 | schemaVersion、严格字段/长度/唯一性、package id 与能力绑定、不可变 id+version、模板过滤、默认拒绝与逐项能力授权、独立实例/会话、SQLite 恢复 | requested skills 当前展示但不自动授权；模型继续走 ModelProfile/assignment | avatar、memory/skill 文件、蓝图 modelPolicy、compatibility/评测 schema |
| 插件 | canonical `prompt-transform` 进入真实 conversation runtime prompt；legacy `commands` 明确转换；staged 校验；原始用户消息持久化不被改写 | 仅声明式 JSON；支持 `/command`、`always`、prepend/append/replace、priority 与资源上限；强制无外发 | 可执行代码、skill/tool/event/widget、网络代理与外发审计 |
| 会话记忆 | 单个 WorkSession 的用户可见聊天历史由本地 SQLite 恢复：跨进程重启、Harness Runtime 重建、权限模式切换和 persisted-log 碰撞轮换都能继续对话；私聊/群聊/世界之间严格隔离；群聊历史保留真实发言人；reasoning、tool-call、tool-result、system、临时气泡与凭据不进入历史 | 预算为「24 条 + 16000 字符」的确定性截断，不使用 tokenizer；超长单条消息截断并标注；每个角色按自身 watermark 增量补齐——新 Session 重播全部，存活 Session 只补它未见过的部分（私聊恒为空，群聊补上一轮晚于自己发言的角色）；同一员工的回合串行、不同员工并行 | Episodic/Semantic/Procedural memory 分类、向量检索、Embedding、自动摘要与记忆整理、跨会话回忆 |
| 会话执行 | `WorkSession → WorkTurn → AgentRun` 持久模型；私聊一轮一次运行，群聊和角色协作按真实调用顺序记录多次运行；本轮消息关联回合，角色输出、领域事件与 SSE 关联具体运行；服务重启确定性终止遗留执行；提供会话回合和回合详情读取 API | 当前只记录生命周期、错误码和 Runtime Session ID，不持久化原始 prompt、工具输入或工具结果 | 自动重试、通用事件 items 表、远程执行同步、审批模型 |
| 模型交互日志 | turn/discovery 双源采集、SQLite 持久化（v11 STRICT 表 + 三索引）、分页/筛选/详情/清空 API、设置面板「日志记录」界面、错误信息密钥清洗（`sk-…`/`Bearer …`/键值对 → `[已隐藏]`） | token 用量字段预留但当前恒为空（DSH worker 未透出单次请求用量）；消息数为近似统计；无自动保留策略 | worker 进程内逐请求采集与 token 透出、日志自动清理/条数上限 |
| CI | Node 22.19、pnpm 11.7、frozen lockfile、typecheck、test、Chromium、E2E | 仓库工作流名为 `required`；GitHub 分支保护需在仓库设置中另行确认 | 自动发布与包签名流水线 |

## 关键证据

- 包审批与事务：`packages/package-runtime/src/package-manager.ts`、`packages/package-runtime/tests/package-manager.test.ts`
- 本地市场与完整性：`packages/package-runtime/src/local-package-catalog.ts`、`packages/package-runtime/src/local-package-runtime.ts`
- 主题 parser：`packages/world-runtime/src/manifest.ts`、`packages/world-runtime/tests/world-runtime.test.ts`
- 安装入口与资产缓存：`packages/server/src/installed-package-runtime.ts`、`packages/server/src/world-theme-package.ts`、对应 tests
- 社区包门禁：`packages/server/tests/marketplace-conformance.test.ts`
- 主题绑定与资产服务：`packages/server/src/world-runtime-service.ts`
- renderer 与动画：`packages/web/src/features/world/renderer`、`packages/web/tests`
- 员工蓝图解析与实例化：`packages/server/src/employee-blueprint-manifest.ts`、`packages/persistence/src/sqlite-store.ts`
- prompt transform：`packages/server/src/prompt-transform-parser.ts`、`packages/server/src/routes/conversation-routes.ts`
- 会话记忆与执行：`packages/orchestration/src/conversation-history.ts`、`packages/orchestration/src/conversation-orchestrator.ts`、`packages/persistence/src/migrations.ts`、`packages/persistence/src/sqlite-store.ts`、`packages/harness-adapter/src/history-prompt.ts`、`packages/harness-adapter/src/adapter.ts`、`packages/orchestration/tests/conversation-history.test.ts`、`packages/orchestration/tests/conversation-memory.test.ts`、`packages/server/tests/conversation-memory-restart.test.ts`
- 模型交互日志：`packages/server/src/services/model-interaction-service.ts`、`packages/server/src/routes/model-interaction-routes.ts`、`packages/persistence/src/migrations.ts`（v11）、[模块说明与观测边界](model-interaction-logs.md)
- CI：`.github/workflows/ci.yml`

## 采用规则

讨论稿条款只有满足以下任一条件才能从 ROADMAP 升级为当前约定：

1. 已进入 versioned contract，并有严格解析和兼容策略；
2. 已进入运行时/持久化真实路径，并有正反测试；
3. 作为社区审核政策明确标注“代码未强制”，且不会暗示产品能力。
