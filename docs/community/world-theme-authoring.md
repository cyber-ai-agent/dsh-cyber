# 世界主题创作约定

世界主题只负责场景表现和领域事件投影，不得写会话、员工、任务或其他领域状态。

## 当前合同

包清单 MUST 使用：

- `kind: "world-theme"`；
- 恰好一个 `kind: "world-theme"` 的 entrypoint；
- `capabilities` 包含 `world:render`；
- 包自身携带所有主题资产，通常 `dataEgress: []`。

entrypoint JSON MUST 满足 `WorldThemeManifestV1`，完整字段和限制以以下源码为准：

- `packages/contracts/src/world-runtime.ts`
- `packages/world-runtime/src/manifest.ts`

顶层字段为 `schemaVersion`、`id`、`version`、`templateId`、`displayName`、`renderer`、`terminology`、`assets`、`actorSets`、`scenes` 和 `activityMapping`。未知字段会被严格解析器拒绝。

## 主题身份和兼容性

`theme.id/version` 是主题身份，`package.id/version` 是分发身份，二者 MAY 不同。绑定和渲染必须使用完整组合身份与内容摘要，不能只比较 `theme.id/version`。

`templateId` MUST 等于目标世界模板 id。当前可选择的模板以 `/api/catalog/world-templates` 和 `packages/catalog` 为准；安装主题只有在模板兼容时才可绑定到世界。同一世界同一时刻只允许一个活动主题，可切换、禁用并回退到内置主题。

## Renderer

合同定义的 `RendererKind` 为：

- `pixi-2d`
- `pixi-2.5d`
- `three-2.5d`
- `three-3d`

当前产品只注册并激活 `pixi-2d`。其余值只保留合同扩展边界，主题 PR 不能宣称 Three.js 已可运行。

## 资产

当前主题资产 kind 只支持 `image` 和 `spritesheet`；音频是 ROADMAP。每个 `assets[].src` MUST：

- 是 manifest `files` 中声明的包内相对路径；
- 使用小写 `assets/...` 路径和 `.png|.jpg|.jpeg|.webp` 扩展名；spritesheet 必须是 PNG；
- 不包含 scheme、查询参数、绝对路径、反斜杠、空段、`.` 或 `..`；
- 穿过的每一级都不是符号链接；
- 图片签名必须与扩展名一致；普通图片不超过 4 MiB，spritesheet 不超过 8 MiB；
- 在 staged 激活校验时通过整包哈希与资产检查，在请求时重新验证目标文件或使用可信的不可变身份缓存。

主题不得引用应用内置 `/assets` 作为包资源，也不得引用 CDN。即使图片通过签名与体积校验，PR 仍应保持资源克制并说明来源和体积。

## 场景和引用完整性

严格解析器会检查嵌套对象、数组、枚举、有限数值、唯一 id、资源引用、锚点引用、动作、导航边界与预算。关键限制包括：

- 至少一个 asset、actor set、scene 和 scene anchor；
- scene 单边不超过 32768；
- navigation 单边不超过 4096，网格总数不超过 1000000；
- JSON 深度、节点数、字符串字节数和集合大小受限；
- `terminology` 的嵌套值必须是有限 JSON 值，不能包含非有限数、控制字符、循环引用或超限对象/数组；
- layer/actor/interactable 引用必须指向已声明对象；
- actor set 的主资产必须引用 spritesheet，且八种活动各至少有一个可回退方向帧；
- blocked cell 必须唯一且位于导航网格内。

## 角色动画

每个 actor set MUST 声明 `idle`、`walking`、`thinking`、`working`、`talking`、`meeting`、`blocked`、`celebrating` 八种 clip。方向使用 `north|east|south|west`。

方向帧可以缺省；renderer 按“目标方向 -> south -> east -> west -> north -> 任一现有方向 -> frame 0”进行明确回退。每种状态 SHOULD 至少提供一个真实方向帧。正式资产不足时允许受控的静态 fallback，但 walking 不得使用上下浮动冒充行走。

Pixi 实现读取 `actorSets.clips`，使用 `AnimatedSprite`/动画控制器，按 `footOffset` 对齐脚底，按角色 Y 值排序，并支持 `occludesActors` 图层。主题作者必须在实际画面中检查桌椅遮挡、脚底锚点、动作切换和四向 fallback。

## 事件、交互和成长

`activityMapping` 的值只能是八种活动状态。社区主题 SHOULD 至少覆盖：

`task.started`、`turn.started`、`tool.started`、`message.appended`、`task.blocked`、`task.completed`、`meeting.started`、`meeting.finished`。

虽然 contract 为扩展事件保留 partial map，严格 parser 会强制上述八个核心事件齐全；其他事件可以按需追加，但值仍只能是八种活动状态。

交互只提交 intent；`assign-task` 和 `start-meeting` 不能自行写 `task.started` 或 `meeting.started`。真实聊天/任务提交后才由领域流程推进状态。

`growthSlots` 只展示来自持久化 milestone/evidence 的 skill、delivery、promotion 等记录。不得生成没有真实来源的装饰性成长徽章。

## 验证

以 `marketplace/themes/official-cyber-nocturne` 为包布局参考，以 `packages/world-runtime/src/themes/cyber-company.ts` 为完整表现参考。当前仓库没有 `dsh-cyber package pack|verify` CLI；应通过现有 UI/API 安装流程与项目测试验证，不能在贡献文档中假设这些命令存在。

主题 PR 除基础门禁外，还 MUST 验证：安装与切换、刷新恢复、资产篡改拒绝、重复 cue/reconnect 幂等、角色动画、成长标记、renderer mount/destroy，以及至少一个目标分辨率的实际截图。
