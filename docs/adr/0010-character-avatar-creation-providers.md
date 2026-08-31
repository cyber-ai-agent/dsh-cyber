# ADR 0010：角色 3D 形象创建 Provider 与性能边界

- 状态：Accepted
- 日期：2026-08-31
- 扩展：ADR 0009 的 Avatar Entry V2

## 背景

让普通用户先准备 `.vrm` 或 `.glb` 文件，再进入“导入形象”，暴露了实现格式而不是产品能力。用户真正需要的是“创建这个角色的 3D 形象”，并且能够在替换角色前预览、确认和回退。

DSH Cyber 已有资产校验、角色形象版本、VRM Renderer 和 2D 降级链路。本次不再造第二套存储或发布协议，而是在这些稳定边界前增加可替换的创建 Provider。

## 决策一：创建能力通过 Provider Registry 接入

```text
CharacterAvatarManager
  -> CharacterAvatarCreationProviderRegistry
      -> LocalProceduralVrmProvider（当前默认）
      -> PhotoToVrmProvider（未来，可选）
      -> WorkshopAvatarProvider（未来，可选）
  -> avatar-assets 校验
  -> preview
  -> publish / rollback
```

- UI 只消费 `CharacterAvatarCreationProvider` 合同，不 import 具体生成算法。
- Provider ID 全局唯一；重复注册立即失败，不能按加载顺序静默覆盖。
- Provider 返回标准 `File`，后续统一复用已有 `avatar-assets -> publish -> profile revision` 链路。
- 本机 Provider 不读取角色 Prompt、对话、Skill、凭据或世界文件，只接收显示名和明确选择的外观参数。
- 未来远程 Provider 若要发送照片或角色资料，必须在具体动作边界单独说明数据、目的地和用途；安装 Provider 不等于获得上传授权。

## 决策二：纯生成器与执行环境分离

`procedural-vrm.ts` 是无 React、无网络、无存储副作用的确定性生成器；输入是结构化 Design，输出是自包含 VRM 1.0 `ArrayBuffer`。浏览器 Provider 默认在独立 Module Worker 中调用它，Worker 不可用时才按需加载到主线程。

生成物采用两层节点：

1. Humanoid Bone 只保存关节层级、平移和旋转；
2. Visual Mesh 是 Bone 的子节点，保存材质与非均匀缩放。

禁止把网格缩放直接写到 Humanoid Bone，否则缩放会沿骨骼树累积，破坏人体比例、动作和后续动画兼容性。

## 决策三：创建与发布是可取消状态机

```text
editing
  -> generating（Worker，可取消）
  -> packaging（自包含 VRM，可取消）
  -> validating（本地服务校验，可取消）
  -> preview（尚未修改角色）
  -> publishing（创建新 profile revision）
  -> active

任一步失败 -> inline error -> 保留外观选择 -> 可重试
关闭/取消 -> AbortSignal -> Worker terminate / fetch abort
```

- 生成完成后焦点进入“发布到角色”，但发布仍需用户显式点击。
- “导入现有形象”保留为折叠的高级方式，不与主创建动作争夺视觉层级。
- 失败、软件 WebGL、低 FPS、减少动态效果继续回退 2D；回退不改变已发布资产。
- 关闭创建器或角色设置必须终止未完成 Worker/请求，禁止后台继续创建孤立资产。

## 性能门禁

- 首屏与普通 2D 模式不加载 Provider、生成器、Worker、Three 或 VRM Runtime。
- Provider 控制代码压缩后目标小于 4 KiB；Worker/生成器各小于 16 KiB；构建预算继续独立检查主包和 VRM 懒加载包。
- 默认模型保持低面数，目标少于 5,000 triangles；只使用自包含 buffer，不产生外部纹理请求。
- 生成在 Worker 中完成，主线程不得出现由模型生成导致的 Long Task；超时 20 秒终止 Worker。
- 预览和 Focus 各自最多一个 WebGL Canvas；卸载、失败和切换必须释放 RAF、Timer、ResizeObserver、材质、几何、RenderList 和 WebGL Context。
- 预览最高 30 FPS；低性能设备 15 FPS；Focus 使用现有 RenderingQuality 与持续低 FPS 降级策略。
- React 只管理状态与占位内容；Canvas 挂载到独立 viewport，禁止 `replaceChildren` 修改 React 管理的子节点。

## 交互与视觉门禁

- 缺少 3D 的角色显示“创建 3D”，不能只写“3D +”或要求用户理解 VRM。
- 创建器先展示 3–5 个可理解选项，技术格式和文件导入渐进披露。
- 生成、校验、预览、发布、取消和失败都有中文状态；颜色不是唯一状态信号。
- 原生 radio/button/details 保持键盘可达，焦点进入创建入口、生成后进入发布动作、取消后返回触发器。
- 1440×900、1920×1080、3840×2160 检查模型比例、无横向溢出、文字对比、最小字号和控制台 error/warn。

## 验证

- 生成器合同：GLB 容器、VRMC_vrm、必需骨骼、独立骨骼节点、自包含 buffer 和不同 Design 输出。
- Runtime 合同：真实 `GLTFLoader + VRMLoaderPlugin` 加载、可见 Mesh、人体包围盒比例和控制器更新。
- Provider 合同：唯一注册、阶段通知、取消和本机文件输出。
- 服务/E2E：创建 -> 服务校验 -> 真实 Canvas 预览 -> 发布 revision -> 3D Focus -> 2D/地图切换。
- 真实浏览器：检查 Worker 懒加载、单 Canvas、资源释放、控制台和三档视口截图。
