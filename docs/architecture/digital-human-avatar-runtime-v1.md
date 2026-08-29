# 数字人形象运行时 V1

## 结论

DSH Cyber 的数字人不应绑定某一个 TTS、头像生成或 3D 供应商。核心只输出角色身份、真实运行状态、回复文本与一组标准化动作意图；2D 精灵、动态肖像、VRM 3D 和未来的供应商通过 Renderer/Generator Adapter 消费这些事实。

第一阶段已经落地本机语音播报与 `expression + gesture` 动作合同。浏览器只在用户点击“播报回复”后读取当前角色的最终回复，代码块和 URL 不会被朗读，内容不上传；待命、思考、执行、说话、待审批、失败分别映射为稳定动作状态，静态模式和系统减弱动态效果继续拥有最高优先级。

## 开源方案调研

| 方案 | 可借鉴能力 | 许可证与限制 | DSH Cyber 决策 |
| --- | --- | --- | --- |
| [pixiv/three-vrm](https://github.com/pixiv/three-vrm) + [VRM 1.0](https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm-1.0) | 浏览器 Three.js VRM 加载、Humanoid、LookAt、SpringBone、表情、口型和动画规范 | MIT；模型资产仍需逐个核对授权 | 作为首选 3D Renderer；按需加载，不进入世界核心 |
| [TalkingHead](https://github.com/met4citizen/TalkingHead) | 浏览器实时 TTS、viseme 口型、表情、全身动作和 Mixamo 动画 | MIT；自定义模型必须具备兼容骨骼及 ARKit/Oculus 口型 blend shapes | 借鉴语音/viseme/动作队列，不直接把其云 TTS 写进核心 |
| [LivePortrait](https://github.com/KlingAIResearch/LivePortrait) | 单张肖像的姿态、眨眼、表情和视频驱动 | 主代码 MIT，但仓库明确说明自带 InsightFace 检测模型仅限非商业研究 | 只作为可选本地动态肖像 Adapter；商业构建必须替换检测器 |
| [MediaPipe Face Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js) | 478 个面部点、52 个 blendshape、面部变换矩阵 | 示例代码 Apache-2.0；同步检测会阻塞主线程 | 用 Web Worker 运行，可用于用户主动开启的表情捕捉/驱动 |
| [TripoSR](https://github.com/VAST-AI-Research/TripoSR) | 单图快速生成纹理网格 | 代码与权重 MIT；输出是通用 Mesh，不自动提供可靠的人形拓扑、骨骼、眼球和口型 blend shapes | 可做实验性 Mesh Generator，不能宣传为“一键可说话 3D 数字人” |
| [Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2) | 高分辨率几何和贴图生成 | 腾讯社区许可证有地域、分发与规模限制 | 不作为默认内置依赖，只允许用户显式安装的外部 Adapter |

## 运行时边界

```text
World/Conversation facts
        ↓
DigitalHumanMotionCue
  state + expression + gesture + optional viseme
        ↓
Renderer Registry
  sprite-2d | live-portrait | vrm-3d
        ↓
WebGL/Canvas/Video presentation
```

- `WorldRuntimeSnapshot` 仍是状态事实源；动画不会反向伪造任务、工具或产物成功。
- TTS Adapter 只接收最终可见回复。推理、工具参数、密钥和隐藏 Prompt 永不进入语音。
- Viseme 是语音输出的可选时间序列；没有 viseme 时只能展示“说话动作”，不能标记为精确口型同步。
- Renderer Registry 必须与 Skill Adapter 一样拒绝重复 ID，并在卸载后安全回退到 `sprite-2d`。
- 3D/动态肖像资源只保存本机 `stateRoot/assets`，Profile 只保存不可执行的资源引用和能力清单。

## 用户上传形象管线

1. 用户显式选择图片或 VRM/GLB，并确认拥有人物肖像及模型资产的使用权。
2. 服务端先写入隔离的临时资产，校验 MIME、大小、哈希、模型结构和纹理总量；不直接发布到角色档案。
3. 图片路线先生成 2D 动态肖像预览；3D 实验路线只生成 Mesh 预览，并明确提示“尚未绑定骨骼/口型”。
4. VRM 路线验证 Humanoid 必需骨骼、表情预设、材质和外部 URI；不合格模型拒绝激活。
5. 用户在预览页确认后创建新的角色 Profile revision，旧形象仍可回滚。
6. 发布资源进入 Backup Bundle；原图、生成中间件和最终资产有独立保留/删除策略。

## 交付阶段

### V1（当前）

- 真实状态驱动的呼吸、扫描、执行、审批、失败和说话动作。
- 手动触发本机 TTS；不自动播放、不上传回复、不朗读代码或 URL。
- Renderer-neutral 的表达与动作合同，为后续 2D/3D 复用。

### V1.1

- 角色档案新增形象管理，支持本地图片和 VRM 导入、预览、版本化发布与回滚。
- `@pixiv/three-vrm` 独立懒加载 chunk；VRM 不可用或 WebGL 压力过高时回退到 2D。
- TTS Adapter 输出标准 viseme；VRM 表情管理器负责眨眼、视线和口型混合。

### V1.2（实验功能）

- 可选本地 LivePortrait 服务，使用可商用检测器替换 InsightFace 模型。
- 可选 TripoSR Mesh 生成作业；自动绑定骨骼和脸部表情未通过验证前不得发布为交互数字人。
- 摄像头表情捕捉必须逐次授权，MediaPipe 推理放入 Worker，原始视频默认不落盘。

## 性能门禁

- 数字人模式的 3D/AI 依赖不得进入主首屏 chunk。
- 右侧 Dock 只允许一个活跃 Renderer；切回地图必须暂停渲染循环、语音和媒体轨道。
- 目标为普通桌面 30 FPS、交互帧 P95 小于 50ms；低性能或不可见页面自动降到 15 FPS 或静态模式。
- VRM/GLB 激活前检查压缩、纹理尺寸和顶点/材质预算；生成任务不得占用会话执行通道。
