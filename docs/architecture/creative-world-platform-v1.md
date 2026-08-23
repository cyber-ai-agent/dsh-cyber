# Creative World Platform V1

## 目标

DSH Cyber 从“内置几个世界和角色”升级为可长期扩展的**本地优先数字世界平台**。应用代码只提供稳定契约、加载器、受控运行时和可审计执行边界；用户世界、角色、创意项目与运行数据独立保存在本地 `stateRoot`，不进入源码仓库，也不会被应用升级覆盖。

当前阶段本地数据是唯一权威源。未来服务器只作为可选同步/备份层接入：断网、退出账号、关闭同步或服务器不可用，都不能让用户本地世界失效。

本阶段收口五条产品链：

1. **角色具身契约**：角色岗位、区域、设施、日常行为和视觉 Rig 都由语义契约声明，不再依赖“工程师/秘书”等名称推断。
2. **创意工坊**：用户基于受支持的世界模板创建自己的世界和角色，项目作为本地 Mod 持久化，并把角色编译成标准 DSH Cyber 扩展包。
3. **会话即联系人**：左栏只保留会话；一个角色对应一个稳定私聊，群聊可以有多个，会话支持置顶和从列表移除。角色档案继续放在右侧。
4. **角色 Skill Runtime**：角色通过显式 `skillGrants` 获得能力；Skill 只产生受约束的结构化动作，由宿主受信任 Adapter 执行。
5. **安全升级**：程序、Harness 与用户数据三个生命周期分离；更新程序不会覆盖世界、角色、Workshop 或 Skill 状态。

## 核心不变量

```text
Character identity
  = Agent identity
  = direct conversation contact
  = world body
  = dossier
  = skill grants
  = embodiment profile
```

所有层都以稳定 `characterId` 关联，禁止通过显示名称猜角色。

同时保持：

```text
World != Character != Skill
```

三者只通过显式契约组合：

- World 提供场景能力与语义设施；
- Character 声明身份、Persona、具身语义与所需能力；
- Skill Adapter 提供受信任、结构化的外部执行能力。

任何一层都不能通过名称、路径或隐藏约定反向推断另一层。

## 本地权威数据布局

```text
<stateRoot>/
  data/
    dsh-cyber.sqlite
  worlds/
    <worldId>/...
  assets/
  packages/
  workshop/
    projects/
      <projectId>/
        project.json
        generated/
          roles/
            <packageId>/
              dsh-cyber.package.json
              blueprint.json
  skills/
    actions.json
  credentials/       # 加密凭据；普通备份排除
  runtime/           # Harness 候选/活动运行时；可重建
  backups/
```

`project.json` 是创意工坊的可移植源描述；`generated/` 是可重建产物；真正进入运行时的角色继续走现有 `PackageManager`、manifest 哈希、入口校验和安装事务。

未来远程同步只需同步/复制同一套 versioned project/package/domain 数据，不改变本地运行时的所有权。

## 应用升级不变量

源码仓库与 `stateRoot` 必须分离：

```text
Git checkout / node_modules / dist
              │
              │ 只更新程序
              ▼
        DSH Cyber runtime
              │
              │ 读取 / migration
              ▼
        persistent stateRoot
```

以下操作不得删除或初始化已有本地数据：

```bash
git fetch origin
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm build
pnpm dsh-cyber -- doctor
pnpm dsh-cyber -- web
```

正式升级流程见 [`docs/operations/local-first-upgrades.md`](../operations/local-first-upgrades.md)。

升级前推荐：

```bash
pnpm dsh-cyber -- backup
```

`.dshbackup` 当前包含 SQLite、世界、资产、已安装包、Workshop 项目和 Skill 动作。Harness/程序升级不得要求用户重新创建世界或角色。

## Mod 安全边界

创意工坊 V1 只允许声明式内容：

- 世界基础模板依赖；
- 世界观、场景说明和视觉 token；
- 角色名称、身份、Persona；
- `EmbodimentProfile` 语义标签；
- 已知 Skill ID 请求；
- 角色请求的受控 capability。

禁止 Mod 声明：

- 任意 JavaScript / Node / shell；
- 任意像素坐标和路径；
- 任意动画帧执行逻辑；
- 未经用户配置的网络凭据；
- 绕过角色权限的共享能力；
- Skill Adapter 实例或宿主内部执行对象。

## 具身角色解析顺序

```text
角色 Profile 显式覆盖
  ↓
Blueprint EmbodimentProfile
  ↓
旧角色岗位名称兼容推断
  ↓
general / public 安全回退
```

新建角色与 Workshop 角色必须优先使用显式 `EmbodimentProfile`，旧名称推断仅保留兼容迁移用途。

`EmbodimentProfile` 只描述语义：

```ts
interface EmbodimentProfile {
  roleTags: string[]
  preferredZoneTags: string[]
  preferredFacilityCapabilities: string[]
  allowedZoneTags: string[]
  homeSlotTags: string[]
  ambientBehaviors: string[]
  actorRigId?: string
  socialPolicy?: {
    canInitiateConversation: boolean
    cooldownSeconds: number
    maxDailyConversations: number
  }
}
```

主题负责把语义映射到自己的 Zone / Facility / Slot。相同角色可以进入办公室、酒馆、住宅或未来 3D 世界，不需要重新编写 Agent 代码。

## 创意工坊构建管线

```text
Workshop input
   ↓ normalize + validate
Embodiment contracts
   ↓
Compile all role packages
   ↓
PackageManager.preview(all)
   ↓
PackageManager.install(each)
   ↓
Create World
   ↓
Recruit Characters
   ↓
Persist project.json
```

关键规则：

1. 所有角色与 manifest 必须先预检，避免第三个角色非法时已留下半个世界；
2. PackageManager 继续拥有 staging、哈希校验、激活与单包 rollback；
3. Workshop 不直接执行第三方代码；
4. generated 文件可重建，创建前失败时直接清理未完成项目目录；
5. Blueprint 的 `requestedSkills` 只是请求，**创建角色时不自动写入 `skillGrants`**；
6. 后续授权必须通过角色 revision/审批 UI 显式完成。

## 会话模型

### 私聊

每个活动角色在当前世界最多存在一个 canonical direct session：

```text
角色存在
→ ConversationHub.ensureDirectSession(characterId)
→ 左栏显示为联系人会话
```

管家默认置顶。私聊从列表删除采用“隐藏会话”语义，历史记录不被后台静默销毁；从角色档案再次发起私聊时自动恢复。

### 群聊

群聊继续允许创建任意多个，每个 session 独立记录参与者和历史。置顶规则只影响当前世界左栏排序，不改变领域会话事实。

会话 UI 偏好存储在独立本地文件中，不修改消息和 Agent 事实源。

## Skill Runtime 架构

### 稳定接口

受 DeepSeek Harness provider/registry 结构启发，新增能力注册在 Agent loop 之外：

```text
CharacterSkillRuntime
  ├─ authorization
  ├─ proposal routing
  ├─ durable action store
  ├─ scheduler
  └─ audit/result injection
           │
           ▼
CharacterSkillAdapterRegistry
  ├─ builtin.home-assistant
  ├─ future.github
  ├─ future.browser
  ├─ future.feishu
  └─ ...
```

`CharacterSkillRuntime` 不允许知道 Home Assistant、GitHub、飞书等供应商细节。

Adapter 接口负责：

```text
prompt/context
   ↓ propose
Structured Action Proposal
   ↓ runtime authorization/persistence
CharacterSkillAction
   ↓ execute
Trusted Adapter
   ↓
Factual Result
```

### Skill ID 所有权

一个活动 Skill ID 只能由一个 Adapter 提供。冲突注册必须失败，禁止通过加载顺序静默覆盖。

### 请求与授权分离

```text
Blueprint.requestedSkills
       ↓ 用户查看
explicit approval / revision
       ↓
EmployeeRevision.skillGrants
       ↓
Skill Runtime
```

`requestedSkills` 不具有执行权。

### 逐动作风险与授权

参考 Codex 的逐命令/逐权限边界，Skill Action 记录：

```ts
interface CharacterSkillAction {
  skillId: string
  adapterId: string
  action: string
  target: string
  label: string
  risk: 'read' | 'write-local' | 'external-side-effect'
  authorization: 'explicit-user-request' | 'preapproved-policy'
  parameters: JsonObject
  status: 'scheduled' | 'executed' | 'waiting-for-integration' | 'failed'
}
```

安装插件、创建角色、请求 Skill 都不能等价于批准外部副作用。

### 调度安全

延迟动作执行前必须重新检查：

- 角色仍存在；
- 角色未归档；
- 世界归属没有变化；
- 当前 revision 仍拥有对应 Skill Grant；
- Adapter 仍存在。

撤销 Skill 后，旧计划不得继续执行。

## Home Assistant V1 Adapter

第一项宿主 Adapter 为 `smart-home.control`：

- 识别开关空调、播放/暂停音乐等有限动作；
- 支持 `HH:mm` 本地计划时间；
- 实际 Home Assistant 连接仅在宿主显式配置 URL/token/entity 时执行；
- 未配置连接时返回“等待绑定”，绝不伪造设备已执行；
- 外部请求有超时和 HTTP 状态结果；
- 凭据只存在 Adapter 宿主配置，不写入 Action 参数或 Agent Prompt；
- 公网地址要求 HTTPS，本地/私有网络可使用 HTTP(S)。

未来 GitHub、浏览器、飞书、MQTT、HomeKit Bridge 等实现同一 Adapter 合同。

## 与 DeepSeek Harness 的关系

DeepSeek Harness 强调所有能力通过插件/Provider 挂到稳定 context 上，而不是修改核心 Agent loop。DSH Cyber 采用相同方向，但在产品层增加角色权限、世界隔离、长期状态与结构化副作用审计。

```text
DSH Cyber domain
   ↓ stable adapter ports
Harness compatibility adapter
   ↓
DeepSeek Harness
```

上层世界/角色/Skill 合同不得依赖 DSH 内部私有 API。

## 与 Codex 权限模型的关系

Codex 对额外网络/文件能力采取最小权限、按动作请求和 sandbox-first 的策略。DSH Cyber 将其映射为：

- requested capability != granted capability；
- package installed != action approved；
- external-side-effect 动作必须有明确授权来源；
- 能在受限 Adapter 内完成的动作，不升级成通用 shell/network 权限；
- 可复用批准未来可以通过受控 policy 表达，但 policy 仍要限制到 Skill/Action/Scope。

## 前端边界

- `App.tsx` 继续作为组合根，不承载 Workshop 领域逻辑；
- 创意工坊作为独立 `CreativeWorkshopDialog`，动态加载；
- `NavigationPane` 只负责会话与入口，不复制 Workshop 状态机；
- Workshop 的世界编辑、角色编辑、语义预设与 Skill 选择应继续拆为可复用组件；
- Skill 目录必须来自服务端 Adapter Registry，前端不得硬编码“当前有哪些 Skill”；
- 角色浏览、档案、能力和管理继续由右侧 Dossier/World 入口承担。

## V1 验收

1. 自定义“短剧投流专家”可以声明 operations/analytics 具身语义，在兼容主题里分配到对应区域，不依赖角色名称；
2. 创意工坊创建的世界和角色在重启后仍存在，源码升级不会覆盖项目目录；
3. 创意工坊生成的角色包经过现有 PackageManager 校验和安装流程；
4. Workshop 角色可请求 Skill，但初始 `skillGrants` 为空，必须后续显式批准；
5. 左侧只显示会话；每个角色只有一个私聊，管家默认置顶；群聊可多建；会话可置顶/取消置顶/隐藏并恢复；
6. 带 `smart-home.control` Grant 的角色能够把“18:30 到家，开启空调并播放音乐”解析为受控计划动作；没有真实连接时明确提示未执行；
7. 延迟 Skill 在授权被撤销后不能执行；
8. `pnpm dsh-cyber -- backup` 包含 `workshop/` 与 `skills/`；
9. 拉取新程序版本后使用同一 `stateRoot`，世界、角色、Workshop、会话和 Skill 状态保持；
10. typecheck、单元/集成测试和 Chromium E2E 全部通过后才允许合并。
