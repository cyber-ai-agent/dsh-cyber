# 创作规范实现状态

本表只描述仓库当前可执行能力。`packages/server/tests/marketplace-conformance.test.ts` 把仓库内市场包的目录可发现性、类型/入口/能力一致性和三类 entrypoint schema 纳入持续测试。

## 结论

世界主题、本地包、员工蓝图和 prompt-transform 已收敛到严格声明式边界；现有领域模型更安全的部分继续保留。远程市场、发布 CLI、密码学签名、依赖解析、任意插件代码和外发监控仍未实现，不能通过文档字段假装存在。World Administrator V1 已进入真实的 SQLite、Server、Skill Runtime 和 Web 路径；产品级 E2E 仍是合并门禁，不通过门禁就不能把该能力标记为稳定发布能力。

会话连续性支持同一会话跨重启恢复，回合与角色执行生命周期也已持久化到本地 SQLite。当前世界可以检索外部原始资料和有证据的长期知识；对话、资料和产物可以通过持久化后台任务整理为世界知识图谱。情景记忆、向量检索和跨设备知识同步尚未实现。

| 领域 | 已实现 | 部分实现/约定补强 | 未实现（ROADMAP） |
| --- | --- | --- | --- |
| 包审批 | 完整 manifest 内容绑定、加密随机 token、TTL、单次消费、活动版本绑定、失败回滚 | grant 存于进程内，重启后需重新 preview | 跨设备/远程审批 |
| 包完整性 | 严格 manifest、未知字段/长度/唯一性、入口-类型-能力关系、完整源目录库存、逐文件 SHA-256、路径/symlink 防护、staged 入口校验、激活后目标文件复验 | license 当前做 SPDX 表达式语法校验，不内置完整注册表 | 密码学签名、透明日志 |
| 本地市场 | themes/plugins/talent 独立目录、搜索、官方 authority + digest、本地安装 | `certification` 不是签名；`verified` 级别不存在 | 远程 index、publish、付费、依赖、更新、卸载 |
| 世界包实例 | 市场目录、工作区只读包库和世界私有实例分层；固定包版本与内容摘要；`origin`、`overrides` 和 SQLite 身份归属世界；Prompt、主题资源和角色蓝图只从当前世界实例进入运行时；创建失败精确补偿 | 主题绑定会显式创建世界实例；同版本请求幂等；不同版本拒绝隐式覆盖；「蓝图只有在世界存在实例时才可招募」在目录、运行时路径与 `POST /api/worlds/:id/recruit` 三处一致强制，非内置蓝图缺少世界实例时返回 422 | 带差异预览的更新、rebase、三方合并、overrides 编辑器 |
| 世界主题 | 严格 nested/JSON parser、资源限制、引用/唯一性、八项核心 activity mapping、极端导航拒绝、安装/绑定/切换/禁用/内置回退 | 当前正式官方 roster 多数状态使用受控单帧 fallback | 音频、多场景切换、Three renderer |
| 主题身份 | package + packageVersion + theme + themeVersion + digest，renderer key 不冲突 | 内置主题使用专用 builtin identity | 签名内容寻址分发 |
| 主题资产 | staged 时整包与逐资产验证、`assets/` 包内路径、PNG/JPEG/WebP 签名、4/8 MiB 上限、不可变身份缓存、请求目标文件复验、越界/symlink 拒绝 | 缓存为进程内可信缓存 | 远程内容存储/CDN（当前明确禁止） |
| Pixi 表现 | RendererRegistry、Pixi 实现、8 状态、四向 fallback、脚底锚点、Y-sort、遮挡、growth badge | 官方 roster 多数 clip 目前是单帧受控 fallback | Three.js、正式多帧全方向资产 |
| 员工蓝图 | schemaVersion、严格字段/长度/唯一性、package id 与能力绑定、不可变 id+version、模板过滤、默认拒绝与逐项能力授权、独立实例/会话、SQLite 恢复 | requested skills 当前展示但不自动授权；模型继续走 ModelProfile/assignment | avatar、memory/skill 文件、蓝图 modelPolicy、compatibility/评测 schema |
| Skill Catalog 与角色学习 V2 | Catalog Service/API 按世界派生发现与 availability；Runtime/employee revision gate 最终可用性；Web 使用 `worldId` 读取蓝图与目录，招募默认勾选 Blueprint.requestedSkills 中当前 World 可用的项；已有角色可学习非 Blueprint Skill；unavailable 历史 grant 可保留或撤销；明确 Plugin Command 不等于 Character Skill | 前端只投影 Catalog Service 结果，不复制权限词汇；UI 与真实 revision、Runtime 和 package instance 路径已接入 | 目录管理界面、跨设备学习同步、证据驱动熟练度 |
| 受控网页浏览 | 官方只读网页浏览扩展提供打开、读取、提取和截图；工作区发现、世界启用、角色授权和单次动作审批彼此独立；DNS 固定到已校验公共地址，禁用脚本、代理、跨主机访问、子资源、弹窗、下载和非只读请求；截图发布到世界产物中心 | V1 只读取用户明确提供的公开 HTTP(S) 地址；不登录、不复用 Cookie、不写世界文件；外部正文按不可信资料隔离；缺少匹配的 Playwright Chromium 时保持未执行 | 登录态浏览、表单提交、交互点击、多主机页面资源、远程浏览器执行 |
| 插件 | canonical `prompt-transform` 进入真实 conversation runtime prompt；legacy `commands` 明确转换；staged 校验；原始用户消息持久化不被改写 | 仅声明式 JSON；支持 `/command`、`always`、prepend/append/replace、priority 与资源上限；强制无外发 | 可执行代码、skill/tool/event/widget、网络代理与外发审计 |
| 会话记忆 | 单个 WorkSession 的用户可见聊天历史由本地 SQLite 恢复：跨进程重启、Harness Runtime 重建、权限模式切换和 persisted-log 碰撞轮换都能继续对话；私聊/群聊/世界之间严格隔离；群聊历史保留真实发言人；reasoning、tool-call、tool-result、system、临时气泡与凭据不进入历史 | 预算为「24 条 + 16000 字符」的确定性截断，不使用 tokenizer；超长单条消息截断并标注；每个角色按自身 watermark 增量补齐——新 Session 重播全部，存活 Session 只补它未见过的部分（私聊恒为空，群聊补上一轮晚于自己发言的角色）；同一会话保持顺序，不同会话可使用独立运行通道 | Episodic/Semantic/Procedural memory 分类、向量检索、Embedding、自动摘要与记忆整理、跨会话回忆 |
| 会话执行 | `WorkSession → WorkTurn → AgentRun` 持久模型；Skill Action 和 Approval Request 绑定同一会话与回合；`waiting-approval` 不占用 Worker 且跨重启保留；审批完成后在原 WorkTurn 新建 AgentRun，不重放用户回合；群聊和角色协作按真实调用顺序记录多次运行 | 当前只记录生命周期、错误码和 Runtime Session ID，不持久化原始 prompt、工具输入或工具结果 | 通用事件 items 表、远程执行同步 |
| Conversation Control 与 Runtime Lanes | Web 显式队列支持等待、下一条执行、撤销、真实停止和 reload 恢复投影；同角色 lane 状态与第三条等待提示；聊天继续隐藏 tool/reasoning | Durable queue/control、abort/interrupted 事实由服务端/Runtime 提供，Web 使用容错 API 客户端和现有 world live | 跨设备队列同步、队列优先级策略、批量取消 |
| 群聊任务路由 | 群聊持久化讨论/任务协作模式；确定性 Router 按当前技能授权、世界可用性、路由词、角色职责与负载选择最多三名执行者；SQLite v26 保存计划、依赖与步骤状态；同一 WorkTurn 内并行或顺序运行并由协调角色汇总；聊天只展示最终回复和轻量分配卡 | 讨论模式保持原有全员轮次；任务计划重启时安全中断，普通历史清理不删除；tool/reasoning/执行事实仍在轨迹 | 多阶段计划编译器、依赖可视化、跨会话任务中心 |
| 世界轨迹 | 每个 AgentRun 投影为一条稳定主轨迹；中文判断摘要、结构化工具调度、状态、耗时、模型和真实 Token 归入同一次运行；按角色汇总 Token；支持角色、日期、关键词、内容和状态筛选以及游标分页；实时与重启恢复使用同一身份；全链路脱敏 | Token 只在 Harness 明确返回时展示，不进行估算；旧运行没有 Token 时保持为空 | 跨设备轨迹同步、用户配置的轨迹保留策略 |
| 应用访问锁 | 全局锁屏覆盖整个工作台；锁定状态下服务端拒绝除健康检查和解锁外的应用 API；密码使用 scrypt 派生哈希保存在本机凭据目录；错误尝试限速；服务重启后默认重新锁定 | 会话当前保存在进程内并具有固定有效期；应用锁不代替操作系统账号、磁盘加密或文件权限 | 系统生物识别、设备间锁状态同步 |
| 世界管理员 | 多管理员、18 项 World Permission、权限审计账本、内联决策与 same-WorkTurn 续跑；权限增删为增量 patch（grant/revoke 不改身份也不丢其他授权，promote 应用完整推荐集），给成员授予管理类权限返回结构化拒绝而非静默过滤；决策按会话隔离；决策审计不随 `prune` 删除；文件访问分 none/read/write 三档，无 read 时运行时锚定在空的受管工作区；每个已发布 Descriptor 都有生产 handler（契约测试保证） | 管理能力是身份标记加权限判定，没有独立 Admin Runtime；一句话中的多个管理动作只执行被识别的那一个 | 计划编译器（多动作）、全局决策中心、插件/模型的中文名解析、一次性 Owner danger 授权 |
| 世界产物 | SQLite 产物登记、不可变版本、精确运行清单、同世界聊天引用、搜索与类型筛选、重命名和归档；Markdown、代码、JSON、PDF、图片、HTML 与项目文件树使用对应阅读器；HTML 预览受 CSP 与 iframe 沙箱隔离；产物随世界备份并由 doctor 检查缺失文件 | 工作目录只在用户或角色提供精确清单时发布，不扫描猜测；当前支持手动填写相对路径发布，用户可明确把已发布版本加入知识库 | 产物差异对比、产物自动入库、跨设备产物同步 |
| 世界知识库 | 世界独立的 KnowledgeCollection、KnowledgeDocument 与 KnowledgeChunk；原始文件位于 `knowledge/library`；支持 Markdown、TXT、JSON、PDF、文件夹、ZIP、粘贴和网页导入；SQLite FTS5 能力检测与可移植回退；聊天热路径使用一次本地检索并通过统一上下文组合器注入；外部资料按不可信数据隔离 | 全文检索为本地词法检索；产物只有在用户明确操作后才加入；缺失源文件保持可诊断状态 | 向量索引、跨设备知识同步 |
| 世界知识图谱 | 世界独立的 Entity、Claim、Relation 与 Evidence；对话游标、整理任务、世界设置和归档抑制均持久化；后台平衡模式按消息量、字符数和空闲时间整理；严格 JSON 与批次证据校验；支持 Canvas 图谱、聚焦、筛选、证据详情、实体改名和主张归档/恢复；运行时组合主张检索、资料分块和一层邻居 | 当前使用词法检索和本地邻居展开；知识提取依赖已配置的世界模型；冲突内容保留并标记，不自动裁决 | 可选 Embedding 适配器、情景记忆、跨设备图谱同步 |
| 设置与模型连接 | 设置内容采用单列信息流；模型连接先配置地址与密钥，再拉取并搜索选择模型 ID；维护页只保留真实应用更新；主题采用完整预设并折叠低频自定义项 | 公开模型目录依赖供应商接口；手动模型 ID 保留为显式备用模式 | 自动供应商账户导入、跨设备设置同步 |
| 应用更新 | 仅支持干净 `main` 分支从 `origin/main` 快进；更新前在隔离工作树完成 frozen install 与 build，并创建完整本地 Backup Bundle | 更新完成后需要用户重启当前进程；非 Git 安装和开发分支会明确显示不支持原因 | 桌面安装包增量更新、签名发布通道 |
| 动作审批 | 外部副作用先持久化 Skill Action 与 Approval Request；两者关联 WorkTurn；未批准、已拒绝、已过期或授权已撤销时不会进入受信任 Adapter；持久执行 CAS 保证单次进入外部边界；审批后崩溃可安全续跑，已进入外部边界的崩溃转为结果未知并禁止自动重试 | 会话内审批卡先展示中文操作、目标和风险，技术标识折叠在详情中；按钮只依据服务端 `allowedScopes` 显示本次、本角色或本世界范围；可复用策略由 Skill Descriptor 显式授权并绑定 Skill、Action、Target、Risk 与作用域，不支持精确参数约束的动态能力只能单次批准 | 独立审批中心界面、通用文件写入审批、远程审批同步 |
| MCP Skill Adapter | 官方 MCP TypeScript SDK Streamable HTTP 客户端；工具发现映射为独立 Skill；调用严格经过角色 Grant、单次 Approval 和 SQLite Action Ledger；禁止创建角色级或世界级持久策略；参数加密暂存并确定性清理；原始结果不持久化 | V1 通过显式 `/mcp 工具名 JSON` 命令提出调用；每个工作区当前配置一个 MCP 服务 | stdio Extension Host、模型原生结构化调用、多 MCP 服务实例管理 |
| 模型交互日志 | turn/discovery/knowledge 三类来源采集、SQLite 持久化、分页/筛选/详情/清空 API、设置面板日志界面、错误信息密钥清洗；turn 日志绑定 WorkTurn 与 AgentRun，知识整理只保存模型、耗时、字符数、真实 Token 和错误分类 | 一条 turn 日志表示整轮角色运行，不拆分 worker 内部的多次模型请求；知识整理不保存来源正文、提取提示或模型原始响应；无自动保留策略 | worker 内逐请求明细、日志自动清理和条数上限 |
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
- 世界管理与权限：`packages/server/src/skills/world-management-host.ts`、`packages/server/src/skills/world-management-adapter.ts`、`packages/server/src/services/world-character-authority-service.ts`、`packages/server/src/services/world-runtime-permission-resolver.ts`、`packages/persistence/src/migrations.ts`（v22）、`packages/server/tests/world-management-host-contract.test.ts`、`packages/server/tests/world-authority-patch-semantics.test.ts`、`packages/server/tests/world-file-access.test.ts`、`packages/server/tests/world-settings-cas.test.ts`
- 本地备份与恢复：`packages/server/src/services/local-backup-service.ts`、`packages/server/tests/local-backup-restore.test.ts`、CLI `backup` / `restore`
- 历史保留与轨迹成本：`packages/persistence/src/sqlite-store.ts`（`pruneHistory`、`listWorldTraceDomainEvents`）、`packages/server/src/services/world-trace-service.ts`（`groupMessagesByRun`）、CLI `prune`、`packages/server/tests/audit-remaining-findings.test.ts`、`packages/server/tests/world-trace-grouping.test.ts`、`packages/server/tests/world-trace-event-filter.test.ts`
- 会话记忆与执行：`packages/orchestration/src/conversation-history.ts`、`packages/orchestration/src/conversation-orchestrator.ts`、`packages/persistence/src/migrations.ts`、`packages/persistence/src/sqlite-store.ts`、`packages/harness-adapter/src/history-prompt.ts`、`packages/harness-adapter/src/adapter.ts`、`packages/orchestration/tests/conversation-history.test.ts`、`packages/orchestration/tests/conversation-memory.test.ts`、`packages/server/tests/conversation-memory-restart.test.ts`
- 动作审批：`packages/server/src/services/turn-aware-approval-continuation-service.ts`、`packages/server/src/services/character-skill-runtime.ts`、`packages/server/src/skills/sqlite-skill-action-repository.ts`、`packages/persistence/src/migrations.ts`、`packages/persistence/src/sqlite-store.ts`、`packages/server/tests/turn-aware-approval-continuation.test.ts`、`packages/server/tests/character-skill-runtime.test.ts`、[Approval Gate V1](../architecture/approval-gate-v1.md)
- MCP Skill Adapter：`packages/server/src/skills/mcp-skill-adapter.ts`、`packages/server/src/integrations/mcp-client.ts`、`packages/server/tests/mcp-skill-adapter.test.ts`、[MCP Skill Adapter V1](../architecture/mcp-skill-adapter-v1.md)
- 受控网页浏览：`packages/server/src/skills/browser-skill-adapter.ts`、`packages/server/src/integrations/browser-client.ts`、`packages/server/src/services/browser-policy.ts`、`packages/web/src/components/ApprovalRequests.tsx`、`packages/web/src/components/OneShotHostAccessDialog.tsx`、[受控网页浏览与权限体验 V1](../architecture/browser-adapter-permission-ux-v1.md)
- 世界轨迹：`packages/server/src/services/world-trace-service.ts`、`packages/server/src/world-trace/agent-run-trace-adapter.ts`、`packages/web/src/components/world-trace/`、[世界轨迹中心](../architecture/world-trace-center-v1.md)
- Conversation Control：`packages/web/src/chat-realtime.ts`、`packages/web/src/components/ChatWorkbench.tsx`、[Conversation Control 与 Runtime Lanes V1](../architecture/conversation-control-runtime-lanes-v1.md)
- 群聊任务路由：`packages/contracts/src/task-collaboration.ts`、`packages/server/src/services/group-task-router.ts`、`packages/server/src/services/group-task-collaboration-service.ts`、`packages/orchestration/src/conversation-orchestrator.ts`、`packages/web/src/components/TaskCollaborationSummary.tsx`、[群聊任务路由 V1](../architecture/group-task-router-v1.md)
- 应用访问锁：`packages/server/src/services/application-access-service.ts`、`packages/server/src/http/application-access-guard.ts`、`packages/web/src/components/ApplicationLockGate.tsx`
- 世界管理员：`packages/contracts/src/world-authority.ts`、`packages/persistence/src/world-character-authority-repository.ts`、`packages/persistence/src/sqlite-store.ts`、`packages/server/src/services/world-character-authority-service.ts`、`packages/server/src/services/world-permission-request-service.ts`、`packages/server/src/services/world-management-intent-parser.ts`、`packages/server/src/skills/world-management-adapter.ts`、`packages/server/src/routes/world-authority-routes.ts`、`packages/web/src/components/WorldPermissionEditor.tsx`、`docs/architecture/world-character-authority-v1.md`
- 世界产物：`packages/contracts/src/world-artifact.ts`、`packages/persistence/src/world-artifact-repository.ts`、`packages/server/src/services/world-artifact-service.ts`、`packages/server/src/routes/world-artifact-routes.ts`、`packages/orchestration/src/agent-run-completion-hook.ts`、`packages/web/src/features/artifacts/`、[世界产物中心](../architecture/world-artifact-center-v1.md)
- 世界知识库：`packages/contracts/src/world-knowledge.ts`、`packages/persistence/src/world-knowledge-repository.ts`、`packages/server/src/services/world-knowledge-library-service.ts`、`packages/server/src/services/world-runtime-context-composer.ts`、`packages/server/src/routes/world-knowledge-routes.ts`、`packages/web/src/features/knowledge/`、[世界知识库](../architecture/world-knowledge-library-v1.md)
- 世界知识图谱：`packages/contracts/src/world-knowledge-graph.ts`、`packages/persistence/src/world-knowledge-graph-repository.ts`、`packages/server/src/services/world-knowledge-consolidation-service.ts`、`packages/server/src/services/world-knowledge-graph-service.ts`、`packages/server/src/services/model-profile-knowledge-extraction-port.ts`、`packages/web/src/features/knowledge/KnowledgeGraph.tsx`、[世界知识图谱](../architecture/world-knowledge-graph-v1.md)
- Skill Catalog 与角色学习：`packages/contracts/src/skill-runtime.ts`、`packages/web/src/components/skill-catalog.ts`、`packages/web/src/components/SkillGrantEditor.tsx`、`packages/web/src/components/RecruitmentDialog.tsx`、[Skill Catalog 与角色学习 V2](../architecture/skill-catalog-character-learning-v2.md)
- 设置、创意工坊与更新：`packages/web/src/components/SettingsDialog.tsx`、`packages/web/src/components/creative-workshop/CreativeWorkshopEditor.tsx`、`packages/server/src/services/application-update-service.ts`
- 模型交互日志：`packages/server/src/services/model-interaction-service.ts`、`packages/server/src/routes/model-interaction-routes.ts`、`packages/persistence/src/migrations.ts`（v11）、[模块说明与观测边界](model-interaction-logs.md)
- CI：`.github/workflows/ci.yml`

## 采用规则

讨论稿条款只有满足以下任一条件才能从 ROADMAP 升级为当前约定：

1. 已进入 versioned contract，并有严格解析和兼容策略；
2. 已进入运行时/持久化真实路径，并有正反测试；
3. 作为社区审核政策明确标注“代码未强制”，且不会暗示产品能力。
