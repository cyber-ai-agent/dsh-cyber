# 可读工具证据与世界成员名册

开发基线：`main@7d6fa682214aad98aa1a4c7e38e6438c6547e3da`。本改动不重建本地世界，不改变执行权限，不共享角色私聊，不修改左侧仅会话的信息架构。

## 工具轨迹

`tool-summary` 将本地文件标识与 URL 凭据策略分开。长文件名、keyboard/token/session 源码与 UUID 产物清单可显示；凭据值脱敏不取消。摘要用于定位对象，展开参数保留正常开发命令及读取范围。

`ToolTraceSubjects` 在单个 AgentRun 内按原生 sessionId/callId 关联开始与结束事件，只保存工具名与内容展示策略，不保存原始参数。结果映射读取 rc.1 的 `message.content -> tool-result.content -> text`，再经统一脱敏与限长后进入持久化和 SSE。实际 write/edit 的 `meta.diffs` 可以作为变更片段，禁止使用模型提议的 old_string/new_string 冒充已发生的变更。

结果最长 4000 字符、参数最长 2000 字符；超长记录明确截断。凭据文件内容、任意内联脚本及尚未适配工具的结果不盲目收录。路径与内容策略分别处理，普通 secret-storage.ts 不作为凭据容器。脱敏先于剪裁，并限制扫描长度与正则键长度。

历史和实时适配器投影同样的 output/flags/exitCode 字段；无实际返回的字段保持缺省。原生 Bash 未上报独立退出码时，只展示其返回文本，不编造数值。旧数据里已丢失的结果或文件名无法还原。

前端去掉 description/input 重复行，独立展开参数与结果，复制相同的脱敏文本，保留多行和长路径换行。清单写入明确区分宿主验签/登记成功。纯文本呈现，不执行结果中的 HTML。

## 世界成员事实

`WorldCharacterDirectoryService` 从既有 SQLite 的当前世界、活动角色实例与当前 Revision 构建公开名册。字段仅含稳定 ID、当前姓名/职责、角色版本、技能授权与世界可用技能。模板、Persona、背景故事和私人记忆不进入名册。技能可用性由现有 availability port 一次批量查询；没有该服务时明确 availabilityKnown=false。

每次统一 CharacterProfileRuntime.runTurn 创建一个本轮快照。成员加入、改名、职责变化、归档或技能变化影响下一轮；普通忙闲及访问时间不改变名册哈希。新增独立 world-directory 上下文层，纳入真实固定输入预算、稳定前缀 hash、Context Inspector 来源与 Token 估算。已有会话不会永久保留创建时的旧名册。

内联最多 24 位、1600 估算 Token，自身优先；大世界明确注明覆盖数，未内联成员仍可完整查询。完整名册保留在本轮工作进程，只读工具不读取任意文件或网络，也不发起协作：

- `world_directory_list`：分页（默认 20、最多 40）并返回 nextOffset。
- `world_directory_search`：按姓名、职责、技能与 ID 检索，重名保留多个稳定 ID。
- `world_directory_get`：按 ID 取公开条目，不返回其他世界的数据。

它们是通过项目现有 SDK bridge 的 world-directory/set 请求实际注册的 Harness 工具，并非 Prompt 中虚构的 API。宿主与工作进程核对角色/世界归属；更新是每轮开始时的快照语义，不冒充实时忙闲。分页可提供 expectedRevision，变化时明确要求重新开始。

查询名册不等于历史上认识或已经联系。真实交流继续使用现有 PeerCollaboration/WorkTurn 路径；本改动不批量伪造关系记录，也不触发角色互相聊天。

## 回归位置与运行边界

- contracts/tool-trace：正常长文件名、凭据形态、控制字符、扫描限长。
- harness-adapter/tool-trace-evidence：实际 rc.1 事件结构、调用归属、输出限长、凭据文件、原生 diff。
- harness-adapter/world-directory-harness.integration：运行真实固定版本 Harness，回环模型发起名册工具调用，核对返回、更新、工具 schema 预算与无审批副作用；不是外部模型质量评估。
- harness-bundle/world-directory-tools：三个查询工具、公开字段投影、更新与跨世界拒绝。
- server/world-character-directory：持久化新增/改名/归档、技能可用性、重名、502 人查询、直接/群组/任务统一注入、预算预检。
- server/trace-evidence-projection、web/world-trace-tool-evidence：历史/实时一致、展示和复制。
- e2e/trace-evidence：实际服务器与浏览器；使用明确的确定性运行时事件，走 normalizer、持久化和真实轨迹 UI，验证打开、复制、刷新及三视口截图。已加入核心 smoke。

验收具体提交、工作流结论与截图位置记录在 PR；未完成的检查不计为通过。应用源码目录与 stateRoot 的边界不变；本次不新增持久化目录，无需额外数据迁移。
