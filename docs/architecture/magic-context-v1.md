# Magic Context V1

## 目标

一次角色回合看到什么，由一个地方决定，并且这个决定是可描述、可复算、可审计的。

在此之前决定被拆成两半：`CharacterProfileRuntime` 负责人格加一段记忆文本，Harness adapter 另外把恢复出来的会话整段重放到前面。没有任何一处拥有完整画面，因此也没有任何一处能给它设上界——长会话每一回合都在重放全部消息。

Magic Context 的目标不是“压缩提示词”，而是把上下文变成一个**有结构的投影**：每一层都知道自己是什么、从哪几行持久化数据推导出来、值多少 token，因此可以被重排、重新分配预算、被检查，也可以在需要时**回到原文**而不是只相信摘要。

验收场景（本文档对应的 `packages/server/tests/magic-context-acceptance.test.ts`）：

```text
会话 A   项目代号 / 架构决策 / 写作偏好 / 关键日期      → 四条经历被记住并索引
会话 B   大量无关闲聊                                  → A 被挤出有界原始窗口
会话 C   “代号校验串是多少？”
             │
             ├─ 记忆索引命中 memoryId
             ├─ memoryId → sourceMessageIds → 原始消息
             └─ 只把这一条经历的原文注入本回合
         答对，且 A 没有被整段重放
```

## 分层信封（D1）

`packages/contracts/src/context-envelope.ts` 定义 `ContextEnvelope`。它描述“进入这次回合的是什么”，不是最终提示词字符串。

| 层 | 内容 | 变动频率 |
| --- | --- | --- |
| `stableIdentity` | 人格、角色资料、世界职权、会话权限、已授权工作方法 | 只随 revision 变 |
| `worldContext` | 世界运行时上下文（仍由 `WorldRuntimeContextComposer` 贡献） | 低 |
| `taskContext` | 路由后的 `TaskCollaborationPlan`：目标、步骤、依赖、已完成步骤、相关产物 | 随计划版本 |
| `memoryIndex` | 本回合“能想起什么”的清单：memoryId、日期、scope | 每回合 |
| `retrievedMemories` | 命中记忆的摘要，必要时附带 `[记忆原文]` 水合块 | 每回合 |
| `recentConversation` | 保持原始对话形态的最近若干轮 | 每回合 |
| `currentRequest` | 本次请求 | 每回合 |

层的顺序 `CONTEXT_LAYER_ORDER` 就是“从最可缓存的前缀到最易变的后缀”。每层带 `id`、`kind`、`revision`、`contentHash`、`tokenEstimate`、`sourceRefs`。

`sourceRefs` 是这套设计的支点。上下文永远是投影；source ref 是让检查器、审计或以后的重排器能够**定位原始行**，而不是只能相信被渲染过的摘要。没有它，一条记忆被裁剪到 700 字之后就再也回不去了。

## 为什么稳定前缀必须是确定性的

`composeStableIdentity` 不读时钟、不读计数器、不读随机源。技能指令与权限授予在进入哈希前被去重并排序（调用方手里拿的是 `Map`，它的迭代顺序被刻意排除在哈希之外），空白段落被丢弃。

`contextContentHash` 是对规范化 JSON 做的 128 位 FNV-1a：无依赖，Node 与浏览器结果一致——同一个信封在两端都要能被描述。它是内容标识，不是安全原语。

结果是 `stableContextHash`：两次携带相同持久事实的回合，前缀逐字节相同。这一条不是洁癖，它是**前缀缓存唯一可能成立的前提**。给 `composeStableIdentity` 加字段，就必须同时给它加归一化。

> 说明：确定性已经成立，缓存本身（D2.5）尚未落在本分支上。今天 `cachedPrefixTokens` 的真实值是 0。

## 记忆索引与检索（D1 / D2）

- 表 `employee_memory_index`（迁移 37，SQLite + FTS5 镜像）。`memory_id` **就是** `employee_milestones.id`，索引从不自铸身份：删除里程碑级联删除索引行，索引失败只丢失排序召回，永远丢不掉事实本身。
- 写入发生在一次 AgentRun 真正完成之后（`rememberCompletedRun`），摘要由“用户提问 + 我的处理”拼成，上限 1600 字。
- `scope` 取自会话种类：`direct → private`、`task → task`、其余 `group`。检索时可见 scope **由持久化 `WorkSession` 推导，永不来自调用方**——群聊回合无法通过忘记传参而够到私聊记忆。
- 候选来自 FTS5（优先 `trigram`，退化到 `unicode61`）；任何 SQLite 构建拒绝该查询形态时退到可移植的 `LIKE` 路径。两条路径都受同一套 scope 过滤。
- 排序是显式的公式，不是黑箱：`关键词命中 + 实体命中 + 时间新近度 + 重要度先验`。实体命中权重高于偶然词重叠；新近度是先验而非主导项，一个相关的旧项目仍然应当压过昨天的无关闲聊。当没有任何词命中时，池子退化为“最近的若干条”，因为一句“还记得吗”不该让角色失去全部连续性。

## 水合：从 memoryId 回到原文

摘要是有损投影。一条 1600 字摘要在 `retrievedMemories` 里只渲染 700 字，被丢掉的恰恰是“具体是哪一串”这类提问真正需要的部分。

`hydrateMemorySources` 用索引保留的 `sourceMessageIds` 把原始消息取回来，并折叠进 `retrievedMemories` 层（不是新层）——这样它与摘要共享同一份预算、同一套顺序、同一组 source ref。

边界是硬的：

- 只水合排名最靠前的 **3** 条记忆，每条最多 **4** 条消息，每条消息截断到 **1200** 字。
- 预算从摘要已有的记忆预算里扣，不是额外追加；按“整段经历”花费，半段经历读起来与真实结束无法区分。
- 已经在原始窗口里逐字重放的消息不会被再水合一次。
- **scope 检查两次**：索引行自身的 scope 必须对当前会话可见，且每一条原始消息还要按它**实际所在会话**重新判定。第二次检查才是要害——索引是派生数据，派生行绝不能是私聊消息与群聊提示词之间唯一的一道门。`conversation-context-hydration.test.ts` 里有一条探针故意把索引行的 scope 改成 `group`，水合仍然必须拒绝。

## 有界原始窗口（D2）

`ConversationContextComposer` 保留最新 **6 个用户回合**的原始形态，其余不再重放。三条例外让它“只会失去压缩率，不会失去一个回合”：

1. **检索一无所获** → `fullReplayFallback`，退回旧的整段重放。检索不是无损的，宁可不省。
2. **从未被记住的回合** → 一次没有产生完成态 AgentRun 的回合（失败、中断、用户说了话但没等到回复）从不写入里程碑，也就从不被索引，检索永远带不回它。窗口因此**向前扩到最早的这类回合**，而不是把幸存者拼接起来——有洞的对话读起来就是另一段对话。最坏情况退化成今天的整段重放，这是诚实的地板。
3. **`observedThroughSequence` 之后的回合**永远保留原始形态：角色在这段会话里已经有持久位置，它之后的一切对它是全新的。

群聊与任务 lane **目前仍然整段重放**，这是设计上的未迁移状态而不是回退：群聊经历只为真正产生了 AgentRun 的那个角色被记住，同伴的发言根本没有为本角色建索引，召回覆盖率不足以支撑丢弃历史。

## D2.5 前缀缓存 / D3 上下文检查器 / D4 上下文快照

这三片与本文档并行开发，**不在本分支上**。本节只记录它们要落进的接缝，不替它们宣称结果。

- **D2.5 前缀缓存**：`stableContextHash` 就是缓存键。基准里的 `cachedPrefixTokens` 字段已经留好，今天恒为 `null`。
- **D3 上下文检查器**：信封的每一层都带 `sourceRefs`，检查器要做的是“显示这一层，并允许跳回它引用的持久化行”，不需要重新推导任何东西。
- **D4 上下文快照**：快照存**指针，不存文本**。理由是 SQLite 是持久事实的唯一真相：把渲染后的文本再存一份，等于铸造第二份会与原始行漂移的真相，而且会把私聊原文复制到一个不再受会话 scope 保护的地方。存 `memoryId` / `messageId` / `revision` / `contentHash` 则可以在事后重新取回原文、验证它是否变过，并且回放时仍然要重新过一遍 scope 检查。快照因此是“这次回合引用了哪些行”，不是“这次回合的提示词长什么样”。

## 验收与基准

`packages/server/tests/magic-context-acceptance.test.ts` 把 A/B/C 场景跑成真实可运行的测试，**不接触任何云端模型**。测试里的 `LabelledFactRuntime` 是一个确定性读取器：它只有在 `X <标识符>` 字面出现在本回合真正拿到的提示词或重放历史里时，才能回答 `X是多少？`。因此“答对”是一个关于事实是否被注入的真实测量，而不是模型能力的抽样。

断言的是两半，缺一不可：答案正确，**并且**会话 A 没有被整段重放——后者对着运行时真正收到的 `AgentTurnRequest` 断言，不是对着编排器自述的 coverage 断言。

基准（本机一次运行，会话 A 四轮 + 会话 B 三十轮闲聊，共 68 条持久消息）：

| 指标 | 整段重放 | Composer（普通长度闲聊） | Composer（一行式闲聊） |
| --- | --- | --- | --- |
| 输入 token 合计 | 9241 | 3465 | 1840 |
| 重放历史 token | 9232 | 1806 | 181 |
| 检索记忆 token | 0 | 1534 | 1534 |
| 重放条目数 | 68 | 13 | 13 |
| 准确 | 是 | 是 | 是 |
| 缓存命中 token | — | 待 D2.5 | 待 D2.5 |
| 编排耗时 | — | 约 3 ms | 约 1 ms |

同一场景下，整段重放的 token 数是 9241 对 3465（比值 0.37）。

**耗时不做门禁。** 测试里的运行时是桩，一次回合的墙上时间没有意义；CI 里唯一有意义的计时是编排本身，而它也只上报不设阈值——共享 CI 机器不是基准机。端到端模型延迟需要手动对真实 provider 跑一次，本套件明确不覆盖。

## 仍然有损的地方

这一节比上面所有内容都重要。一份粉饰的文档比没有文档更糟。

1. **只有词法召回，没有语义排序。** 命中靠字符串重叠。一个与摘要不共享任何词的提问会掉到“新近度 + 重要度”兜底，也就是可能召回错的经历。
2. **中文长句只取前 6 个二元组。** `memoryIndexTerms` 对长度超过 4 的汉字连续段取二元组，且只取 `min(6, 长度-1)` 个。一句很长的中文提问里，**只有开头一小段真正参与检索**；把关键词放在句末的提问会明显变差。
3. **提问被截断成查询。** 超过 500 字的提示词会被截到 500 字再进检索（`MAX_MEMORY_INDEX_QUERY_CHARS`）。技能续跑那种携带整份行动报告的提示词，实际参与检索的只是开头。
4. **水合深度是硬上界。** 3 条记忆 × 4 条消息 × 1200 字。一段横跨十几条消息的长经历，回来的永远只是它的开头。
5. **群聊 / 任务 lane 仍然整段重放。** 上面说过原因；这意味着 Magic Context 今天只对私聊 lane 生效。
6. **覆盖判定只看最近 500 条索引行。** `MAX_COVERAGE_MEMORIES` 决定“哪些旧回合还能被检索带回来”。越过这个上界只会让编排器保留**更多**原始历史，所以它失败的方向是重放而不是丢回合——但它确实是一个上界。
7. **没有产生完成态 AgentRun 的回合永远不被记住。** 它只能靠窗口前扩留在原始历史里；一旦它也被更长的会话推得足够远，行为等价于整段重放。
8. **群聊经历只为发言的那个角色被记住。** 同伴说过的话不在本角色的索引里。
9. **摘要两次截断。** 摘要本身封顶 1600 字，在 `retrievedMemories` 里再渲染成 700 字。没有水合时，700 字之后的一切对模型不存在。
10. **短会话上 composer 是净亏。** 上表第三列：一行式闲聊场景里 composer 的输入 token 比整段重放**更多**（1840 对 1759，比值 1.05）。检索加水合是一块近似固定成本的开销，只有当它替换掉的历史比这块开销更贵时才划算。这一条被写成断言固定在测试里（`terse.inputTokenRatio > typical.inputTokenRatio`），以免它悄悄从记录里消失。
11. **token 数是估算。** `estimateTextTokens` 是汉字计 1、其余按 3.5 字符折算的近似，不是任何 provider 的真实分词结果。表里的比值可靠，绝对值不可靠。
12. **缓存与快照的数字还不存在。** `cachedPrefixTokens` 与 `snapshotPointerTokens` 在基准输出里恒为 `null`，等 D2.5 与 D4 落地后填入。

## 验收命令

```bash
pnpm typecheck
pnpm vitest run --project node packages/server/tests/magic-context-acceptance.test.ts
pnpm vitest run --project node packages/server/tests/conversation-context-composer.test.ts \
  packages/server/tests/conversation-context-hydration.test.ts \
  packages/server/tests/character-profile-context-runtime.test.ts
pnpm vitest run --project node packages/persistence/tests/employee-memory-index.test.ts
```

基准结果以一行 `magic-context-benchmark {json}` 打印在测试 stdout 上，可直接被脚本消费。本片不新增迁移（37 已被 `employee-memory-index` 占用）。
