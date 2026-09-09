# 机器档案（Environment Profile）设计

状态：设计已定稿，待排期实现。
决策记录：D1 本机档案全局共享、设备档案按 integration 隔离；D2 CLI 探测 = 内置白名单（~30 项）+ 世界设置自定义项；D3 失败学习只收集宿主确定性归纳的环境类失败，模型叙述类失败不收集；D4 活跃会话中档案发生**实际变更**时，向当前 lane 追加一行系统提示（不进稳定层、不进聊天气泡，只进轨迹与上下文事件区）。

## 1. 问题

模型的系统上下文只声明了工具的存在，不知道工具落到这台机器上是什么样：什么系统、什么 shell、装了哪些 CLI、哪些缺失。任务到达后只能「猜 → 试 → 失败 → 再猜」，烧轮次、烧 token，还往轨迹里堆失败噪音。

环境事实是**确定性的、可探测的、变化缓慢的**，应该由宿主查，而不是让模型试。

## 2. 三层结构

| 层 | 执行者 | 成本 | 保什么 |
|---|---|---|---|
| 探测 | 宿主（本地命令 / `sshExecOnce`） | 快速层 ~100ms；完整层 1–3s | 事实 |
| 注入 | 会话边界固定的档案快照 → 稳定前缀层 | ~200–300 token，被 prompt cache 覆盖 | 第一轮规划正确 |
| 按需 | 模型用现有 shell 工具现查（`where` / `command -v` / `Get-Command`） | 几十 ms/次 | 中途的实时正确性 |

分工原则：**快照管规划（稳定、可缓存），现场查管细节（实时、无缓存冲突）**。P5 才考虑专用 `machine.profile` 模型工具（需要 harness 宿主组合的插件行，跨包边界，最后做）。

## 3. 数据合同

存储：`stateRoot/environments/<profileId>.json`。`profileId`：本机 = `local`；远程设备 = 对应 `integrationId`。

```ts
interface EnvironmentProfile {
  schemaVersion: 1
  profileId: string
  os: 'windows' | 'macos' | 'linux'          // 本机 = process.platform；远端 = uname
  arch: string
  shell: string                              // 本机探测到的 shell 方言（pwsh/bash/zsh + 受限模式标记）
  tools: Record<string, {
    present: boolean
    version?: string                          // 完整层填充
    source: 'builtin' | 'custom'              // 自定义项标记
    lastCheckedAt: string
  }>
  notes: Array<{
    id: string
    text: string          // ≤120 字，宿主生成的确定性陈述
    source: 'probe' | 'failure-signature' | 'user'
    createdAt: string
  }>                          // ≤10 条
  probedAt: string             // 完整层时间戳（元数据，绝不进注入文本）
  fastSignature: string        // 存在性列表的哈希（快速层比对用）
  fullDirty: boolean           // 快速层发现存在性翻转 / TTL 到期 → true
}
```

确定性规则：**注入文本 = f(tools 存在性 + 版本 + notes + shell/os 事实)**，不含 `probedAt`、不含计数与时间戳——对齐 `WorldContextPort` 的稳定前缀约束（“读时钟或计数器的来源会在每一轮悄悄击穿缓存”）。同一档案内容 → 同一注入文本 → prompt cache 前缀稳定。

## 4. 模块边界（`packages/server/src/environments/`，新目录）

| 文件 | 职责 |
|---|---|
| `environment-probe.ts` | 探测电池。本地：`os/arch` + shell 方言（含 pwsh 受限模式探测）+ 白名单存在性（批量一次 `where`）+ 版本命令（固定、并行、每命令独立超时）。远端：同一套问题打包成**一次** `sshExecOnce` 往返（批量 `command -v` + `uname -a`）。版本命令全部来自固定白名单，无用户拼接。 |
| `environment-store.ts` | 档案读写（原子写、校验回读，沿用本地备份的发布语义）、`fastSignature` 计算、`fullDirty` 标记、notes 有界维护。 |
| `environment-context-layer.ts` | `composeEnvironmentLayer(profile, { budgetTokens })` → `{ text, revision }`。文本带 300 token 硬上限（超限按「未装清单 → 版本 → notes」顺序降级省略）；revision = 文本哈希。 |
| `environment-change-collector.ts` | 从 `AgentRuntimeEvent`（tool result）确定性识别环境类信号：**白名单特征匹配，不碰模型叙述**。三类：① 档案说「没有」的命令执行成功 → 补 tool + dirty；② 档案说「有」的命令报 not-found/模块缺失 → 移除 + note；③ 受限模式/沙箱拒绝特征（EPERM/ConstrainedLanguage 等固定串）→ note。 |
| `environment-service.ts` | 对外门面：`current(profileId)`（会话边界语义见 §5）、`refresh(profileId, tier)`、`addCustomTool(profileId, name, versionCommand?)`（白名单模式校验）、`signal(profileId, event)`（change-collector 入口）。 |

## 5. 刷新策略（实现后的最终形态）

**只有会话边界可以探测，且只在档案欠一次刷新时探测**（`snapshot({ worldId, characterId, laneBoundary })`）：

| 边界条件 | 动作 |
|---|---|
| 档案不存在 | 快速层（纯 PATH 扫描，零子进程） |
| `fullDirty` 或 `probedAt` ≥ 24h | 完整层（版本电池，结算欠账、清 `fullDirty`） |
| `probedAt` ≥ 30min | 快速层（presence 重扫） |
| 其余 | 不探测，直接读已存档案 |
| 非边界回合（会话中途） | **永不探测**，只读；变更由收集器写入 |

- `fullDirty` 语义：版本欠账。由收集器（presence 变化）或"首次建档 / 快速层发现 presence 变化"置位，只有完整层清除。因此"装了新软件"最多让下一次会话边界多跑一次完整层，随后归零。
- 快速层保留上一次完整层学到的版本（`mergeToolFacts`），不会因为重扫而丢掉版本号。
- 探测失败只保留已有档案并照常注入；绝不因为探测失败清空档案或打断回合。
- **lane 存活期间注入文本固定**：lane 首轮选定的 revision 连同文本、presence 列表与"已告知 revision"一起盖在持久 assistant 消息上，后续轮次复用。
- **失败/不一致驱动**：change-collector ①②③ 在回合结束后写档案（不改注入前缀），并置 `fullDirty`。
- **用户手动**：「刷新档案」按钮 = 完整层；新增自定义项只定向探该项。
- 远程设备**不在回合内探测**：只有已授权且已建档的设备才会作为块进入本机层；设备探测只由连接中心的显式刷新触发。

**D4 的中途一行提示**：当 lane 的 pin revision 与当前档案 revision 不同、且该 revision 尚未告知过时，向**易变尾部**追加一行 `[系统提示] 机器档案已更新：新增可用：… / 不再可用：…。本轮仍按会话开始时固定的档案执行…`，同时把该 revision 记为已告知。它不进稳定前缀（前缀保持 lane 首轮的内容），也**不进聊天气泡**（Chat 只展示最终结果），随轨迹可查。

## 6. 上下文装配接入点

`CharacterProfileRuntime.runTurn`（`packages/server/src/services/character-profile-runtime.ts`）：

- `fixedContext` 数组中，`directoryLayer` 之后、`turnPrompt` 之前插入 `environmentLayer.text`（本机 lane 用 `local` 档案；动作路由到 SSH 设备的世界/回合用该设备档案——设备档案与本机档案**互斥注入**，不叠加）。
- 稳定层尾部附一行固定指令：「本机/目标设备命令可用性的实时确认请用 shell 现场查询（where / command -v / Get-Command），不要盲试。」
- 参与既有 `planContextBudget` / `assertContextInputFits` 固定输入预算。
- lane pin：首轮选定档案 revision 记入 lane 观测游标；同 lane 后续轮次沿用（即使档案已变）；D4 的一行提示负责「知道变了」。

## 7. 远程设备（连接中心）

- 档案按 `integrationId` 隔离；快速层 = 一次 SSH 往返；完整层默认关闭、用户手动或脏标记触发（远端成本高）。
- 脏信号来源：`ssh-skill-adapter` 动作执行结果（成功但档案说没有 → ①；not-found → ②），同样白名单特征匹配。
- 入口：连接中心设备详情页（展示/刷新/notes），与本机共用同一组件。

## 8. UI 入口（遵守产品信息架构）

- **世界设置** → 「机器档案」区块：本机档案摘要、刷新按钮、自定义 CLI 列表（增删）、notes 只读列表。
- **连接中心** 设备详情 → 同形区块（设备档案）。
- 不新增左侧导航入口；低频设置放现有设置/详情页签。

## 9. 持久化与备份

- `environments/` 加入本地 Backup Bundle：`local-backup-service.ts`（L126 目录列表、L256/L456/L462 顶层校验集合）、`local-restore-transaction.ts`（L9 允许集）、`system-routes.ts`（L66 included 列表）五处同步。
- 档案不含凭据；notes 仅宿主生成/宿主维护；恢复走既有 versioned migration 通道（`schemaVersion` 字段做前向迁移锚点）。

## 10. 安全边界

- 探测只读；版本命令固定白名单，自定义项只允许「存在性检查 + 白名单模式的版本命令」（正则校验，拒绝任意 shell 拼接）。
- 版本输出只取首个非空行、上限 64 字，且只写档案、不进日志；注入文本与轨迹展示继续走同一套脱敏链路。
- notes 上限 10 × 120 字；模型叙述**永不**进档案（D3）——注入层因此不构成 prompt 注入面。
- 档案内容对前端是只读展示；「刷新/自定义项」走既有审批/权限链（世界设置权限）。

## 11. 实施顺序

| 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
| P0 | probe + store + 本机档案 + context layer 注入 + 指令一行 + lane pin + Backup Bundle 五处 | 新会话首轮注入；同内容同文本（缓存稳定测试）；预算断言通过；备份/恢复包含 `environments/` | ✅ 已落地 |
| P1 | change-collector（①②③）+ `fullDirty` + D4 中途一行 | 装新软件 → 下会话自动带上；活跃 lane 收到一行提示；叙述类失败零收集（对抗测试） | ✅ 已落地 |
| P2 | 世界设置「机器档案」页签 + 连接中心设备区块（展示、刷新、自定义项）+ 路由 | 手动刷新链路 + 自定义项定向探测 + 三视口可测量门禁 | ✅ 已落地 |
| P3 | 远程设备档案（SSH 一次往返电池 + 单层内多设备块 + 动作结果脏信号） | 设备档案按连接隔离；未授权设备不进 prompt；设备事实不回写本机档案 | ✅ 已落地 |
| P4 | 档案迁移 + 备份/恢复回归测试 | 备份/恢复包含 `environments/`；未知 schemaVersion 视为缺失并重探 | ✅ 已落地 |
| P5（可选） | `machine.profile` 模型工具（harness 宿主组合插件行） | 工具下钻替代 shell 现查；跨包边界评审后再动 | 未开始 |

实现期相对本文的三处收敛（均为工程约束驱动，已在上文对应小节记录）：

1. §5.3 服务启动探测 → 首个 lane 惰性 + 快速层；完整层由显式刷新触发。
2. §5/§6 的「设备层与本机层互斥」→ **单层内多块**（envelope 只有一个 `environment` 槽位，lane pin 也只有一个键）；远端块在降级阶梯中先于本机块被丢弃。
3. §4 的 `addCustomTool(profileId, name, versionCommand?)` → 只接受**名字**，版本由固定参数阶梯探测，owner 无法注入命令行；设备档案不开放自定义项。

每个阶段：contracts/schema 测试 + server 单测 + 浏览器 e2e（P2 触发 AGENTS 视觉门禁，除截图外还断言字号下限、父级透明度、WCAG AA 对比度与横向溢出）。

## 12. 与既有不变量的关系

- **不改 Agent loop**：档案是上下文源 + 宿主信号收集器，注册在 `CharacterProfileRuntime` 的稳定接口旁（对齐「新增能力优先注册在稳定接口旁边」）。
- **Chat/轨迹边界**：D4 提示与档案更新事件只进轨迹/事件区，不进聊天气泡。
- **脱敏边界**：档案是宿主生成的环境事实，不含凭据；notes 白名单特征匹配，模型叙述零进入——与 trace 脱敏规则正交。
- **本地优先**：档案权威数据在 `stateRoot/environments/`，随 Backup Bundle，git pull/重装不触碰。
