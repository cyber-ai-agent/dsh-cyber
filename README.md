<div align="center">

# DSH Cyber

### 一个本地优先、可具身、可成长、可连接真实世界的 AI 角色与世界平台

**Build a living AI world — characters with identity, memory, bodies, skills, relationships and real actions.**

[官网](https://www.sandaoliu.cn/) · [English](./README_EN.md) · [技术报告](./docs/technical-report.md) · [Roadmap](./docs/roadmap.md) · [贡献指南](./CONTRIBUTING.md)

[![CI](https://github.com/cyber-ai-agent/dsh-cyber/actions/workflows/ci.yml/badge.svg)](https://github.com/cyber-ai-agent/dsh-cyber/actions/workflows/ci.yml)
[![Full E2E](https://github.com/cyber-ai-agent/dsh-cyber/actions/workflows/full-e2e.yml/badge.svg)](https://github.com/cyber-ai-agent/dsh-cyber/actions/workflows/full-e2e.yml)
[![GitHub stars](https://img.shields.io/github/stars/cyber-ai-agent/dsh-cyber?style=flat)](https://github.com/cyber-ai-agent/dsh-cyber/stargazers)
[![License](https://img.shields.io/badge/license-see%20LICENSE-blue)](./LICENSE)

> **Pre-Alpha** — 项目仍在快速重构。当前重点是把 Creative Platform V1 的架构边界做对，再进入稳定兼容阶段。

</div>

---

## 为什么做 DSH Cyber？

我们希望 AI 角色不再只是一个 Prompt。

```text
Character
├─ Identity
├─ Persona
├─ Agent Session
├─ Model Policy
├─ Embodiment
├─ Memory
├─ Relationships
├─ Skill Grants
├─ Work History
├─ Evidence
└─ Growth
```

一个角色应该能长期存在，有自己的会话、档案、身体、关系、技能和成长轨迹；进入不同世界时保持身份一致；需要调用真实世界能力时，通过受控 Skill Adapter 完成真实动作，并把结果写回可审计状态。

DSH Cyber 想把这件事做成一个**可视化、可玩、可扩展的本地 AI 世界平台**：你可以经营一家公司，也可以创建酒馆、创作工作室、家庭空间、虚拟伙伴世界，甚至通过 Skills 联动 GitHub、浏览器、Home Assistant、IM 机器人和其他真实系统。

---

## 当前已经实现

### 🧠 Persistent AI Characters

- 每个角色拥有独立 Agent session、模型策略、档案和长期身份。
- 一个角色对应一个稳定 canonical 私聊，会话可以置顶/隐藏，管家默认置顶。
- 角色可以参与真实多角色协作，不由一个“总控 Prompt”假装所有人发言。
- 角色之间的共享经历和关系证据可以持久化。

#### Persistent Memory 的当前边界

- 同一个会话的最近聊天历史由本地 SQLite 恢复，可以跨应用重启、Harness Runtime 重建和权限模式切换。私聊、群聊和不同世界之间不共享历史。
- 每次用户交互和每次实际角色运行都有持久状态，可查看私聊、群聊和角色协作的运行顺序与结果。服务重启会安全终止未完成记录，不自动重放可能产生副作用的调用。
- SQLite 是会话历史与执行状态的权威；DSH Session 和实时事件是可重建的运行时状态。
- 跨会话语义检索、情景记忆、向量索引、自动摘要与记忆整理尚未实现。角色不会跨会话自动回忆或提炼长期知识。
- 世界轨迹按角色、日期、关键词和执行状态检索中文执行记录，展示安全的判断摘要、工具调度、耗时与模型返回的真实 Token 用量。完整 Prompt、原始工具输入和原始工具结果不会进入轨迹；模型返回的已完成 reasoning 块会经密钥脱敏和长度截断后展示，不做摘要或翻译，流式 reasoning 增量则被直接丢弃。

### 🌍 Embodied Worlds

- World Runtime + World Simulation 分层。
- PixiJS 可视化世界、状态投影、角色移动、会议、灯光与具身动作。
- deterministic role-aware ambient life，避免无意义随机走动。
- 自定义角色通过 `EmbodimentProfile` 使用语义标签绑定区域、设施、行为和动画 Rig。
- 世界、角色、Skill 三者显式解耦。

### ✨ Creative Workshop

- 顶栏独立「创意工坊」入口。
- 新建世界采用四步向导，依次配置世界、角色、权限与 Skills、创建前确认；页面不会一次铺开全部高级字段。
- 本地项目库：用户创建的世界项目保存在 `stateRoot/workshop`。
- 世界观、场景、角色 Persona、Embodiment 与 Skill 请求分别建模。
- Workshop 会把角色编译成标准扩展包，再经过 `PackageManager` preview / install。
- 支持基于已有项目创建安全副本，避免直接覆盖运行中的不可变历史。

### 🧩 Market / MOD Foundation

统一市场包含：

- World Themes
- Plugins
- Character Blueprints

扩展包拥有 manifest、内容哈希、权限声明、来源和安装事务。当前第三方运行入口仍以声明式能力为主，不默认执行任意 JS / shell。

### 🔌 Trusted Skill Runtime

Skill 当前采用：

```text
Available
≠ Requested
≠ Granted
≠ Approved Action
≠ Executed Action
```

已完成：

- `CharacterSkillRuntime`
- `CharacterSkillAdapterRegistry`
- 结构化 Skill Action
- risk / authorization / adapterId / status
- durable scheduling
- Home Assistant Adapter V1
- 内置研究、开发、内容、项目管理和本地文件等 Skill Recipes，可按角色职责提供默认能力建议。
- Integration Registry 与 Firecrawl Adapter V1。
- MCP Streamable HTTP Adapter V1，工具发现和调用继续经过角色授权、逐动作审批与本地 Action Ledger。

### 🔐 应用访问与世界管理

- 可设置全局应用锁；锁定后整个工作台被锁屏界面遮住，服务端同时拒绝世界、会话、消息和设置请求。
- 密码使用本机派生哈希保存，不写入 SQLite、日志或前端响应；每次服务启动后需要重新解锁。
- 每个世界拥有一个或多个 World Administrator。管理员身份和 18 项 World Permission 由 SQLite `WorldCharacterAuthority` 持久化；管理员 Badge、角色权限编辑器、审计记录、最后管理员保护和同世界权限委托都走真实服务端边界。World Administrator 只在当前世界生效，不等于应用管理员，也不会自动获得 `danger-full-access`。
- 缺少世界权限时，角色可以在当前聊天中发起精确的 World Permission Request；用户选择本次允许、长期授予或拒绝后，原 WorkTurn 继续，不重复执行整轮用户消息。外部副作用仍须经过现有 Approval Gate。
- 管理员可通过受信任的 `builtin.world-management` 动作修改当前世界设置、角色、World Package Instance 和模型分配；设置使用 revision 冲突保护，模型分配以 SQLite 为权威。

**世界管理能力的当前边界：**

- **可用的自然语言动作**：修改世界设置、重命名世界、修改角色身份、管理角色权限（设为/取消管理员、增删单项权限）、启用/停用世界插件、修改世界默认模型。每个动作先经过权限判定，缺权限时在**当前会话**出现决策卡。
- **暂不支持**：一句话里的多个管理动作只会执行被识别的那一个；用中文名指代插件或模型需要与内部标识一致；同名角色不会被猜测，会直接不执行。
- **决策按会话隔离**：在会话 B 输入「批准」不会批准会话 A 的请求；当前会话有 0 个或多个待决策时不猜测。
- **权限增删是增量的**：授予某项权限不改变角色身份，也不丢其他权限；只有「设为/取消管理员」才改变身份。给普通成员授予管理类权限会被明确拒绝并提示先设为管理员，而不是静默删掉。
- **文件访问分三档**：没有 `world.files.read` 的角色仍可聊天，但运行时被锚定在一个空的受管工作区，读不到真实世界文件；有 read 的只读真实目录；有 write 的可写。
- **完整主机访问不是世界权限**：管理员权限永远不会提升为 `danger-full-access`。它只能由用户在本机显式风险确认后签发一次性授权，绑定到具体世界、角色和这一次请求，用后即失效，进程重启即撤销。**角色自己的任何请求都无法签发它。**
- **决策变化是推送的**：待处理决策由 `world-decision` 事件驱动刷新，而不是每个流式 token 都拉一次列表；轮询降级为断线兜底。属于其他会话的决策不显示在当前输入框上方，但会显示数量提示，不会静默消失。
- **权限卡显示具体动作**：适配器调用、目标和脱敏后的参数，而不只是一个权限键名。
- **世界设置并发**：同一世界的写入串行，携带相同 revision 的两次保存只有一次成功，另一次返回冲突；不同世界仍可并发。
- **权限决策审计不会被 `prune` 清理**：清理只扫已结束的运行遥测，决策记录保留，且在其所属回合被清理后仍可通过会话与动作追溯。
- **多动作不是全局事务**：跨 SQLite 与文件系统不伪造原子性，部分成功会如实报告已完成与未完成。
- AI 模型连接先填写服务地址和密钥，再拉取、搜索并选择模型 ID；模型密钥只在当前设备加密保存。
- 设置页采用单列内容流，维护入口只保留真实的检查和安装更新功能。

外部动作只有 Adapter 返回真实执行结果后，Agent 才能告诉用户“已经完成”。

### 💾 Local-first & Safe Upgrades

本地 `stateRoot` 当前是权威数据源。

完整 `.dshbackup` 已覆盖：

```text
SQLite
worlds/
assets/
packages/
workshop/
skills/
```

凭据、运行时二进制和可重建缓存不进入普通备份。

应用源码、Harness 与用户数据拥有不同生命周期；正常升级不会通过删除本地世界来“解决问题”。

---

## 界面与世界示例

> Creative Platform V1 的 UI 仍在快速调整。下面先展示当前内置世界视觉资产；稳定后的工作台 / 创意工坊 / 角色档案截图会统一放入 `docs/assets/screenshots/`，避免 README 长期挂着已经失效的开发截图。

<table>
<tr>
<td width="50%">
<img src="./packages/web/public/assets/cyber-office-world.png" alt="Cyber Office World" />
<br/><b>赛博公司世界</b><br/>角色工作、协作、会议与状态会投影到可视化世界。
</td>
<td width="50%">
<img src="./packages/web/public/assets/moonlit-tavern-world.png" alt="Moonlit Tavern World" />
<br/><b>月影酒馆世界</b><br/>同一套 Character / Conversation / World Runtime 可以承载完全不同的世界语义。
</td>
</tr>
</table>

当前信息架构已经收敛为：

```text
Topbar
├─ 创意工坊
├─ 市场
├─ 运行时健康
└─ 设置

Left
└─ 会话（类似微信会话列表）

Center
└─ 对话 / 工作台

Right
├─ 世界
├─ 轨迹
├─ 计划
└─ 档案
```

市场负责安装模板和扩展；档案负责实例化、配置、授权和查看具体角色。

---

## 架构

```mermaid
flowchart TB
    UI[Web UI / Creative Workshop / World]
    API[Local API + Event Stream]
    DOMAIN[Domain Services]
    WORLD[World Runtime + Simulation]
    CHAR[Character / Dossier / Growth]
    CONV[Conversation / Collaboration]
    SKILL[Skill Runtime + Adapter Registry]
    PKG[Package / MOD Runtime]
    STORE[SQLite + Local State Roots]
    HARNESS[Harness Compatibility Adapter]
    DSH[DeepSeek Harness]
    REAL[GitHub / Browser / Home Assistant / IM / ...]

    UI --> API --> DOMAIN
    DOMAIN --> WORLD
    DOMAIN --> CHAR
    DOMAIN --> CONV
    DOMAIN --> SKILL
    DOMAIN --> PKG
    DOMAIN --> STORE
    CONV --> HARNESS --> DSH
    SKILL --> REAL
```

核心不变量：

```text
World != Character != Skill != Harness
```

一个稳定 `characterId` 连接：

```text
Agent identity
= canonical direct conversation contact
= world body
= dossier
= memory owner
= growth owner
= skill grant owner
```

详细设计见：

- [技术报告](./docs/technical-report.md)
- [Creative World Platform V1](./docs/architecture/creative-world-platform-v1.md)
- [Architecture & Development Guidelines](./docs/development/architecture-guidelines.md)
- [CI Strategy](./docs/development/ci-strategy.md)

---

## 从 DeepSeek Harness 与 OpenAI Codex 吸收什么？

DSH Cyber 不把两个项目的内部实现直接复制进领域层，而是吸收它们值得长期保留的工程思想。

### DeepSeek Harness

参考 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)：

- Registry / factory / scoped setup 分离；
- 能力通过稳定 Context/Provider 边界组合；
- setup 完成后再 publication；
- 生命周期和 ownership 显式；
- 不为了新增能力不断修改 Agent loop。

### OpenAI Codex

参考 [`openai/codex`](https://github.com/openai/codex)：

- sandbox-first；
- 最小权限；
- 对命令、网络、文件、工具调用等具体 Action 做审批；
- 一次授权、会话授权、策略修改拥有不同语义；
- 将风险和用户授权程度绑定到实际动作，而不是绑定整个插件。

DSH Cyber 再在上层加入：**世界、具身角色、长期记忆、关系、成长、本地所有权、MOD 和真实 Skill Action**。

---

## 快速开始

### 环境

- Node.js `22.19+` 或 `24+`
- pnpm `11.7+`

### 安装

```bash
git clone https://github.com/cyber-ai-agent/dsh-cyber.git
cd dsh-cyber
pnpm install
pnpm build
pnpm dsh-cyber web
```

默认监听：

```text
127.0.0.1:43123
```

常用命令：

```bash
pnpm dsh-cyber doctor
pnpm dsh-cyber backup --output ./backup.dshbackup
pnpm dsh-cyber web --no-open
pnpm typecheck
pnpm test
pnpm test:e2e
```

---

## 更新到最新版本，同时保留本地世界

推荐流程：

```bash
# 1. 先备份本地状态
pnpm dsh-cyber backup

# 2. 更新程序代码
git fetch origin
git switch main
git pull --ff-only origin main

# 3. 更新依赖并构建
pnpm install --frozen-lockfile
pnpm build

# 4. 检查本地状态
pnpm dsh-cyber doctor

# 5. 启动
pnpm dsh-cyber web
```

如果你使用自定义 `--data-dir`，升级前后继续使用**同一个目录**。

完整说明：[Local-first Upgrades](./docs/operations/local-first-upgrades.md)

### 当前开发期的兼容边界

目前仍处于 Pre-Alpha，尚未形成真实外部安装用户规模。Creative Platform V1 定型前，如果实验性旧结构严重阻碍正确架构，我们会优先做一次干净重构，而不是永久背负大量只服务于开发快照的兼容补丁。

**从正式声明本地数据兼容基线的版本开始**，所有持久化变更都必须使用 versioned migration + backup / restore 验证，正常升级不得清空用户数据。

---

## 模型与 Harness

模型配置支持多种供应商与 OpenAI-compatible endpoints，并允许：

```text
Employee model
  > World model
    > Workspace default
      > Default model profile
```

Harness 被限制在兼容适配层，不允许世界、角色、Skill 领域代码依赖 Harness 私有 API。

设置中的“应用更新”会检查 `main` 稳定通道，只接受干净工作树上的快进更新。安装前会在隔离工作树完成依赖安装和构建，并创建完整本地备份；更新完成后由用户重启应用。

底层 Harness 更新仍使用独立的候选版本检查、contract test、canary、人工激活、完整本地备份和 rollback 流程。

---

## 开发状态 / TODO

完整列表见 [Roadmap](./docs/roadmap.md)。当前重点：

- [ ] Creative Platform V1 稳定化
- [ ] Workshop 项目版本与编辑生命周期
- [ ] Character Identity / Persona / Embodiment 完全以用户当前设定为准
- [ ] 跨会话长期记忆与语义检索
- [ ] Task / Job / Deliverable / Review 工作系统
- [ ] GitHub Skill Adapter
- [ ] Browser Skill Adapter
- [ ] 飞书 / QQ / 微信 Channel Adapter
- [ ] Autonomous Collaboration Policy
- [ ] MOD 远程索引、签名、依赖与更新
- [ ] 自定义角色 Body / Rig / 动画资产
- [ ] 未来 3D 世界能力
- [ ] 可选加密云同步（本地仍为权威）

---

## 开发规范

我们希望这个项目越做越大，但不要越做越难改。

几个硬规则：

1. **不要通过角色名字写业务逻辑。**
2. **不要在核心 Runtime 里堆供应商 `if/else`。**
3. **requested capability 与 granted capability 必须分离。**
4. **外部真实动作必须结构化、可审批、可审计。**
5. **复杂 UI 继续拆组件，不把状态全部塞回 `App.tsx`。**
6. **新增持久化目录必须同步进入备份策略。**
7. **兼容基线之后，schema 变化必须有 migration。**
8. **测试产品契约，减少对按钮位置和 DOM 排列的耦合。**

详细规范：

- [`AGENTS.md`](./AGENTS.md)
- [`docs/development/architecture-guidelines.md`](./docs/development/architecture-guidelines.md)
- [`docs/development/ci-strategy.md`](./docs/development/ci-strategy.md)
- [`CONTRIBUTING.md`](./CONTRIBUTING.md)

---

## CI 策略

项目当前处于快速架构期，因此 CI 分层：

```text
Required PR CI
└─ typecheck + unit/integration

Full Chromium E2E
├─ main push
├─ nightly
└─ manual dispatch
```

当前已经有 200+ unit/integration tests。进入 Alpha 后会增加少量核心 Smoke E2E 为 Required；进入 Beta / Stable 后再逐步把完整 E2E、migration、backup/restore、OS matrix 和 Harness Canary 收紧为发布门禁。

---

## 项目方向

我们希望最后得到的不只是一个“多 Agent 面板”。

更接近：

```text
AI Character Platform
+ Visual World Simulation
+ Persistent Memory & Growth
+ MOD Ecosystem
+ Real-world Skill Runtime
+ Harness Runtime
```

你可以创建一家公司，也可以创建一只长期陪伴你的猫、一个酒馆老板、一个内容工作室、一支开发团队，或者完全不同的世界。

角色会有自己的经历，会记住发生过的事情，会形成关系，会通过真实工作积累证据和成长；当被授权时，它们还能通过 Skills 跨出虚拟世界，真正操作现实系统。

---

## Contributing

项目仍然非常早期，架构讨论、世界设计、Character / MOD 设计、Skill Adapter、测试、文档和 UI 都欢迎贡献。

请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [Architecture Guidelines](./docs/development/architecture-guidelines.md)。重大领域变化建议先讨论边界，再写实现。

---

## Links

- Website: https://www.sandaoliu.cn/
- Repository: https://github.com/cyber-ai-agent/dsh-cyber
- DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness
- OpenAI Codex: https://github.com/openai/codex

---

<div align="center">

**DSH Cyber is still early. That is exactly why we are investing in the architecture now.**

</div>
