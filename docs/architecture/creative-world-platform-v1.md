# Creative World Platform V1

## 目标

DSH Cyber 从“内置几个世界和角色”升级为可长期扩展的本地数字世界平台。应用代码只提供稳定契约、加载器和受控运行时；用户世界、角色和 Mod 独立保存在本地数据目录，不进入源码仓库，也不会被应用升级覆盖。

本阶段同时收口四条产品链：

1. **角色具身契约**：角色岗位、区域、设施、日常行为和视觉 Rig 都由语义契约声明，不再依赖“工程师/秘书”等名称推断。
2. **创意工坊**：用户基于受支持的世界模板创建自己的世界和角色，项目作为本地 Mod 持久化，并把角色编译成标准 DSH Cyber 扩展包。
3. **会话即联系人**：左栏只保留会话；一个角色对应一个稳定私聊，群聊可以有多个，会话支持置顶和从列表移除。角色档案继续放在右侧。
4. **角色技能适配层**：角色通过 skill grant 获得能力。技能只产生受约束的结构化动作，由受信任适配器执行；第三方包不能直接运行任意 JS、系统命令或控制世界坐标。

## 不变量

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

## 本地 Mod 布局

```text
<stateRoot>/workshop/
  projects/
    <projectId>/
      project.json
      generated/
        roles/
          <packageId>/
            dsh-cyber.package.json
            blueprint.json

<stateRoot>/packages/
  ... PackageManager 激活后的标准扩展包
```

`project.json` 是创意工坊的可移植源描述；`generated/` 是可重建产物；真正进入运行时的角色继续走现有 `PackageManager`、manifest 哈希、入口校验和安装事务。未来远程上传只需要上传同一个项目/包协议，不需要改变运行时。

## Mod 安全边界

创意工坊 V1 只允许声明式内容：

- 世界基础模板依赖；
- 世界观、场景说明和视觉 token；
- 角色名称、身份、Persona；
- `EmbodimentProfile` 语义标签；
- 已知 skill id；
- 角色请求的受控 capability。

禁止 Mod 声明：

- 任意 JavaScript / Node / shell；
- 任意像素坐标和路径；
- 任意动画帧执行逻辑；
- 未经用户配置的网络凭据；
- 绕过角色权限的共享能力。

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

## Skill Runtime

```text
User message
  ↓
Character skill grants
  ↓
Skill Intent Router
  ↓
Structured Skill Action
  ↓
Trusted Adapter
  ↓
Execution result / scheduled result
  ↓
Agent runtime prompt receives factual result
```

大模型和第三方包只能选择已授权的结构化动作，不能直接执行网络请求或系统命令。

V1 内置 `smart-home.control` 适配契约：

- 识别开关空调、播放/暂停音乐等有限动作；
- 支持 `HH:mm` 本地计划时间；
- 实际 Home Assistant 连接仅在宿主显式配置 URL/token 时执行；
- 未配置连接时返回“等待绑定”，绝不伪造设备已执行；
- 网络连接、超时和响应状态全部形成可审计结果；
- skill grant 不会扩大角色其他文件/模型权限。

未来 MQTT、HomeKit Bridge、飞书、GitHub、浏览器自动化等都实现同一 Adapter 接口。

## 前端边界

- `App.tsx` 继续作为组合根，不把创意工坊逻辑塞进去；创意工坊作为独立 Portal/Launcher 挂载。
- `NavigationPane` 只负责会话列表和当前世界设置入口，不再同时维护通讯录。
- 角色浏览、档案、能力和管理继续由右侧 Dossier/World 入口承担。
- 重型创意工坊组件使用动态加载，避免继续扩大首屏 bundle。

## V1 验收

1. 自定义“短剧投流专家”可以声明 operations/analytics 具身语义，在兼容主题里分配到对应区域，不依赖角色名称。
2. 创意工坊创建的世界和角色在重启后仍存在，源码更新不会覆盖项目目录。
3. 创意工坊生成的角色包经过现有 PackageManager 校验和安装流程。
4. 左侧只显示会话；每个角色只有一个私聊，管家默认置顶；群聊可多建；会话可置顶/取消置顶/隐藏并恢复。
5. 带 `smart-home.control` 的角色能够把“18:30 到家，开启空调并播放音乐”解析为受控计划动作；没有真实连接时明确提示未执行。
6. typecheck、单元/集成测试和 Chromium E2E 全部通过后才允许合并。
