# Core Contract Boundaries

> Creative Platform V1 架构约束。该文档描述 **World / Character / Skill** 三个核心域之间允许和禁止的依赖方向。

DSH Cyber 当前仍处于 Pre-Alpha，可以主动清理早期错误抽象；当 Creative Platform V1 的本地兼容基线正式冻结后，下列边界应作为长期兼容契约维护。

## 1. 核心依赖方向

```text
                    ┌──────────────────────┐
                    │   Application Host   │
                    │ server / desktop ... │
                    └──────────┬───────────┘
                               │ compose
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
      World Runtime      Character Runtime      Skill Runtime
          │                    │                    │
          │                    │                    │
          └──────────────► Core Contracts ◄────────┘
                               ▲
                               │ consume
                      Creative Workshop
                               │
                         compile packages
```

核心原则：

1. Creative Workshop 是**创作入口**，不是 Character Runtime 的基础依赖；
2. Character Runtime 不依赖具体 World Theme；
3. Skill Runtime 不依赖具体 Skill Provider；
4. World Runtime 不通过角色中文职位名决定新角色行为；
5. 具体 Provider、Adapter、Renderer 在 composition root 或 registry 中组装；
6. Package 只能声明能力请求，不能获得宿主执行对象。

禁止出现：

```text
Character Runtime -> Creative Workshop type
Skill Runtime     -> Home Assistant / GitHub / Feishu implementation
World Runtime     -> if (role === "秘书") { ... }  // 新代码
Package           -> host Adapter instance
```

## 2. Character Blueprint

`EmployeeBlueprint` 是角色模板的核心、不可变、可版本化合同。

它当前包含：

```text
identity seed
persona seed
requested skills
requested capabilities
EmbodimentProfile
origin / legacy worldTemplateId
```

Blueprint 只提供模板默认值。用户创建出的 Character Instance 有自己的当前身份、Persona、Profile、关系、记忆、Skill Grants 和成长记录。

### 2.1 Embodiment 是核心合同

`EmbodimentProfile` 位于：

```text
@dsh-cyber/contracts/embodiment
```

它不属于 Creative Workshop。

Creative Workshop、市场角色包、内置角色都使用同一个 `EmployeeBlueprint.embodiment`。

持久化路径：

```text
Blueprint package
  ↓ parse
EmployeeBlueprint.embodiment
  ↓ save
SQLite employee_blueprints.embodiment_json
  ↓ load
Character behavior resolver
```

禁止在招聘时把 Blueprint Embodiment 再复制一份到 Profile，避免出现两个事实源。

### 2.2 当前解析优先级

```text
Character Profile explicit override
  ↓
Blueprint Embodiment
  ↓
legacy role inference
  ↓
general / public safe fallback
```

Profile 表示**用户当前覆盖**；Blueprint 表示**模板默认值**。

### 2.3 `worldTemplateId` 的语义

早期版本把 `worldTemplateId` 当成角色模板的硬世界绑定。

Creative Platform V1 起：

- Blueprint **有显式 Embodiment**：角色模板视为可移植，`worldTemplateId` 主要保留作者来源 / legacy metadata 语义，不作为角色身份来源；
- Blueprint **没有 Embodiment**：按 legacy 模板处理，继续限制到原世界模板，直到升级为可移植角色合同；
- `personal-world` 保留当前兼容行为。

因此不要再根据 `worldTemplateId` 推断 Persona、关系、职业或视觉身份。

未来如果需要更严格的跨世界能力协商，应新增显式 compatibility contract，而不是重新滥用 `worldTemplateId`。

## 3. Character 当前身份

创建时 Blueprint 的 `role` 是初始身份标签，不是永久 System Prompt。

当前 Character Identity 至少由以下状态共同组成：

```text
current display name
current identity / form label
current Persona revision
relationship to user
profile / background
Embodiment override or Blueprint default
memory
skill grants
model assignment
history and growth
```

例如用户把一个初始“秘书”角色改成：

```text
名字：团子
身份 / 形态：陪伴小猫
关系：陪伴伙伴
自称：本喵
Persona：安静、好奇、偶尔吐槽
```

运行时不能继续注入“你是一名秘书”。

Blueprint 仍保留创建来源，当前身份由 Character 自己的最新状态决定。

## 4. Skill Runtime

Provider-neutral Skill 合同位于：

```text
@dsh-cyber/contracts/skill-runtime
```

核心类型包括：

```text
CharacterSkillAction
CharacterSkillResult
CharacterSkillDescriptor
SkillActionRisk
SkillActionAuthorization
SkillActionStatus
```

这些类型不能属于 Creative Workshop，因为网页、聊天、自动任务、外部 IM、Task Runtime 都可能调用 Skill。

### 4.1 Runtime 与 Adapter

```text
CharacterSkillRuntime
  │
  │ only depends on
  ▼
CharacterSkillAdapterRegistry
  │
  ├─ HomeAssistantSkillAdapter
  ├─ future GitHubAdapter
  ├─ future BrowserAdapter
  ├─ future FeishuAdapter
  └─ ...
```

`CharacterSkillRuntime` 负责：

- 当前 Character Grant 校验；
- proposal 调度；
- durable action；
- scheduled execution；
- 执行前再次校验权限；
- factual result；
- 审计状态。

它不负责：

- 注册 built-in Provider；
- 读取 Home Assistant / GitHub / 飞书凭据；
- Provider HTTP 协议；
- Package 安装；
- UI。

### 4.2 Registry 由 Host 注入

参考 Harness Provider Registry 的设计，Registry 属于宿主 composition root。

```ts
const registry = createBuiltinSkillRegistry()
const skillRuntime = new CharacterSkillRuntime(store, { registry })
```

测试、桌面版、未来云端 Host 可以注入其他 Registry：

```ts
createCyberServer({
  ...options,
  skillRegistry: customRegistry,
})
```

Runtime 不允许偷偷创建默认 Provider。

### 4.3 三层权限

```text
Host provides Skill Adapter
          ↓
Blueprint requests skillId
          ↓ owner approval
Character Revision grants skillId
          ↓ concrete request
Skill Action authorization
          ↓
Adapter execution
```

满足：

```text
available != requested != granted != authorized action
```

Package 安装不会自动扩大 Character 权限。

## 5. World Runtime

World/Theme 负责：

- Scene；
- Zone；
- Facility；
- Slot；
- semantic tag mapping；
- renderer assets；
- animation presentation。

Character 提供语义需求：

```text
preferredZoneTags
preferredFacilityCapabilities
allowedZoneTags
homeSlotTags
ambientBehaviors
```

Theme 将这些语义映射成自己世界中的空间。

模型不直接选择：

- pixel coordinates；
- path nodes；
- sprite frames；
- renderer internals。

因此同一个角色可以进入办公室、酒馆、住宅、未来 3D 世界，而不修改 Agent Runtime。

## 6. 用户数据与更新

核心代码与用户数据必须分离：

```text
source / dist / node_modules      -> replaceable runtime
stateRoot                         -> user authority
```

正常升级不得覆盖：

- SQLite；
- Workshop projects；
- user worlds；
- Character revisions/profile/history；
- packages；
- assets；
- Skill actions；
- Harness sessions；
- local settings。

任何持久合同修改必须：

1. 提升 schema/version；
2. 提供 migration；
3. 保留完整 backup/restore 边界；
4. 为 migration 增加回归测试；
5. 不用 UI 代码临时猜旧数据格式。

## 7. 开发规则

新增功能前先判断它属于哪个层：

```text
Contract
Persistence
Runtime
Adapter
Application Service
UI
Package / Mod
```

如果一个文件同时出现：

```text
Provider HTTP
SQLite SQL
React state
Agent prompt
World coordinates
```

通常说明边界已经混乱，应先拆组件再继续功能。

优先扩展 Registry / Port / Adapter / Contract；避免在核心循环里增加供应商或角色名称分支。

### Review checklist

- [ ] 新角色是否依赖 display role name 才能正常运行？
- [ ] 新 Skill 是否需要修改 `CharacterSkillRuntime`？
- [ ] 新 World Theme 是否需要修改 Character/Agent 代码？
- [ ] Package 是否获得了不属于它的宿主执行能力？
- [ ] `requested` 与 `granted` 是否被混为一谈？
- [ ] 用户修改当前角色后，旧 Blueprint 是否仍污染 System Prompt？
- [ ] 数据格式变化是否有 versioned migration？
- [ ] 升级是否会覆盖 `stateRoot`？
- [ ] 测试验证的是产品契约，还是脆弱的 UI 布局细节？
