# Architecture & Development Guidelines

本文件定义 DSH Cyber 从 Creative Platform V1 开始长期遵守的工程约束。目标是让项目持续扩展世界、角色、Skills、Tools、MOD 和 Harness，而不把核心代码演化成大量角色名判断、供应商分支和 UI 状态堆叠。

## 1. 领域边界优先

核心对象必须保持显式边界：

```text
World
Character / Employee
Conversation
Embodiment
Skill / Tool
Package / MOD
Memory / Growth
Harness Adapter
```

禁止通过显示名称、中文岗位、目录名或 UI 文案推断领域能力。

例如：

```text
名字：团子
形态：猫
关系：陪伴伙伴
Persona：傲娇、敏感、亲近主人
```

运行时必须优先使用用户保存的 Character Identity、Persona、Relationship、Embodiment 和 Memory。即使该角色最初由“秘书”模板派生，也不能继续因为旧 blueprint 名称返回“我是秘书”的固定设定。

## 2. World / Character / Skill 解耦

### World

只提供：

- 世界身份与设置；
- Theme / Scene；
- Zone / Facility / Slot 等语义能力；
- 世界事件、快照与运行时投影；
- 世界级模型/权限/文件根。

World 不知道具体角色叫“工程师”“秘书”还是“猫”。

### Character

角色由稳定 `characterId` 串联：

```text
Character identity
= Agent identity
= canonical direct conversation contact
= world body
= dossier
= memory owner
= growth owner
= skill grants owner
```

角色定义包含身份、Persona、模型策略、关系、记忆、成长、具身语义和能力请求。

### Skill

Skill 由宿主 Registry 提供，由 Character 显式获得 grant。

```text
installed / discoverable
!= requested
!= granted
!= approved action
```

核心 Runtime 只做授权、路由、调度、持久化、审计和结果注入；Home Assistant、GitHub、Browser、Feishu 等供应商逻辑必须位于独立 Adapter。

## 3. 采用 Harness 的组合思想

DeepSeek Harness 的 Agent service 把 live registry、factory delegation、scoped setup 和 publication boundary 分开：Agent 在完整 setup 成功前不发布，失败可以回滚。DSH Cyber 借鉴这一点，把新能力放在稳定 Registry / Adapter 边界，而不是修改 Agent loop。

我们进一步增加产品领域层：

- 世界隔离；
- 角色身份与长期状态；
- 角色级授权；
- 持久化记忆；
- 具身世界投影；
- 可审计真实副作用。

上层领域代码不能依赖 Harness 私有 API。DeepSeek Harness、Codex 或未来其他 Harness 只能通过 `packages/harness-adapter` 一类稳定端口接入。

## 4. 采用 Codex 的最小权限思想

Codex 将命令、网络、文件变更、MCP Tool Call 等建模为具体动作，并携带 risk / authorization / approval decision。DSH Cyber 将此原则映射到 Skill Action：

```text
角色拥有 Skill
        ↓
Skill 提议具体 Action
        ↓
风险/Scope/Target 判断
        ↓
用户请求或预批准策略
        ↓
Trusted Adapter 执行
        ↓
真实结果写入审计与 Agent 上下文
```

不要实现“安装插件 = 永久允许一切”。可复用授权必须限定到明确的 Skill / Action / Target / Scope。

## 5. 创意工坊是一套 Compiler Pipeline

创意工坊不直接写运行时对象。推荐管线：

```text
Project Source
  ↓ normalize / validate
Portable Contracts
  ↓ compile
Generated Package / MOD
  ↓ preview
PackageManager
  ↓ install
Runtime Entity
```

生成产物可重建，用户 Project Source 是长期资产。

在 V1 稳定后，项目原地修改必须引入版本语义；在版本迁移策略完成前，优先“基于项目创建副本”，避免静默覆盖已存在角色、会话和历史证据。

## 6. 具身绑定必须语义化

`EmbodimentProfile` 描述：

- roleTags；
- preferredZoneTags；
- preferredFacilityCapabilities；
- allowedZoneTags；
- homeSlotTags；
- ambientBehaviors；
- actorRigId；
- socialPolicy。

不得存储：

- 固定坐标；
- 写死路径；
- 动画帧索引；
- `role.includes('工程师')` 之类的主运行时判断。

Theme 将语义映射为具体世界空间。同一个 Character 可以进入办公室、酒馆、住宅、未来 3D 世界，而不重写 Agent 逻辑。

## 7. 组件化前端

`App.tsx` 只作为 composition root。

新增复杂功能时优先拆为：

```text
feature/
  model.ts
  api.ts
  components/
  state/
```

Creative Workshop 已按项目库、世界编辑器、角色编辑器、共享 model 拆分。未来 Skill Picker、Embodiment Editor、Memory Inspector、MOD Manager 继续沿用同样结构。

全局入口、世界入口、角色入口、会话入口职责必须清楚：

- 顶栏：Creative Workshop / Market / Settings；
- 左栏：Conversations only；
- 右栏：World / Dossier；
- Market：安装模板/扩展；
- Dossier：实例化、编辑和授权具体角色。

## 8. 本地数据与程序生命周期分离

```text
Git checkout / node_modules / dist
          │ program update
          ▼
      DSH Cyber
          │ versioned read/migrate
          ▼
       stateRoot
```

正常更新不得删除 `stateRoot`。

### 当前 Pre-Alpha 规则

当前尚未形成真实外部用户群，Creative Platform V1 定型前允许进行一次较干净的数据结构重构。如果旧开发快照严重妨碍正确架构，可以明确标记开发数据不兼容，不要为了不存在的外部用户堆叠永久兼容补丁。

### 兼容基线之后

一旦项目声明某个版本为本地数据兼容基线：

- schema 变化必须 versioned；
- migration 必须可测试；
- migration 失败不得继续写新数据；
- 更新前支持完整 `.dshbackup`；
- 禁止建议用户删除本地目录解决普通升级；
- 新增持久化目录必须进入 Backup Bundle。

## 9. 持久记忆与成长

长期目标至少区分：

```text
Episodic Memory      发生过什么
Semantic Memory      学到了什么事实
Procedural Memory    怎么做更好
Relationship Memory  与谁形成了什么关系
```

Memory 不能等同于无限聊天记录。必须有来源、时间、作用域、置信度/证据和可回收策略。

Growth 必须由 Evidence 驱动：任务、评审、交付、Skill Action、共享 Episode 等事实产生技能熟练度和里程碑。模型自己声称“我学会了”不能直接改变能力等级。

## 10. 真实世界副作用必须诚实

UI 动画、Ambient Life、自然语言回复都不能作为真实执行证据。

外部动作必须存在结构化状态，例如：

```text
scheduled
executed
waiting-for-integration
failed
```

只有 Adapter 的真实执行结果才能让 Agent 对用户说“已完成”。

## 11. 测试策略

- 当前 Required：typecheck + unit/integration；
- Full E2E：nightly / main / manual；
- Alpha 后增加 Smoke E2E；
- 重点测试产品契约，不绑定脆弱布局细节。

详见 [`ci-strategy.md`](./ci-strategy.md)。

## 12. 代码评审检查单

提交复杂功能前确认：

- 是否新增了显示名称/岗位硬编码？
- 是否把供应商逻辑塞进核心 Runtime？
- requested 与 granted 是否混淆？
- 是否绕过 PackageManager / Harness Adapter？
- 是否产生无法审计的真实副作用？
- 是否把复杂状态继续塞进 `App.tsx`？
- 是否新增持久化路径却没更新 Backup？
- 是否需要 schemaVersion / migration？
- 是否能通过新的世界、角色、Skill 或 MOD 复用，而无需复制整套代码？

如果答案不理想，优先重构边界，再继续堆功能。
