# 数字人形象运行时 V1

## 结论

DSH Cyber 的数字人不应绑定某一个 TTS、头像生成或 3D 供应商。核心只输出角色身份、真实运行状态、回复文本与一组标准化动作意图；2D 精灵、动态肖像、VRM 3D 和未来的供应商通过 Renderer/Generator Adapter 消费这些事实。

当前实现已经落地本地 Voice Conversation、`expression + gesture` 动作合同、VRM 1.0 运行时和本地形象版本管理。中文 TTS 使用 sherpa-onnx Node Runtime + Kokoro 82M int8，提供 55 个女声与 45 个男声；STT 使用 Streaming Paraformer int8，Silero VAD 负责可靠分段，独立快速能量门负责 150ms 内 Barge-in。模型按需加载到 Worker Thread，不进入浏览器包或阻塞 Node 主循环。用户可选择关闭、手动或自动播报，配置按角色持久化；自动模式消费 `text.delta`，经 SentenceChunker 尽早生成首句。麦克风音频和回复内容默认不落盘、不上传。

世界概览与数字人属于同一世界右栏，通过紧凑的“地图 / 2D / 3D”视图控件切换，不提升为重复的全局页签。进入 2D/3D 后，选择私聊会直接切换对应角色；群聊将最新发言者放在中心并展示其他参与者。Focus 继承当前世界主题底图、角色、运行状态和最终回复，不创建默认“行动舱”或另一套事实源。

## 开源方案调研

| 方案 | 可借鉴能力 | 许可证与限制 | DSH Cyber 决策 |
| --- | --- | --- | --- |
| [pixiv/three-vrm](https://github.com/pixiv/three-vrm) + [VRM 1.0](https://github.com/vrm-c/vrm-specification/tree/master/specification/VRMC_vrm-1.0) | 浏览器 Three.js VRM 加载、Humanoid、LookAt、SpringBone、表情、口型和动画规范 | MIT；模型资产仍需逐个核对授权 | 作为首选 3D Renderer；按需加载，不进入世界核心 |
| [TalkingHead](https://github.com/met4citizen/TalkingHead) | 浏览器实时 TTS、viseme 口型、表情、全身动作和 Mixamo 动画 | MIT；自定义模型必须具备兼容骨骼及 ARKit/Oculus 口型 blend shapes | 借鉴语音/viseme/动作队列，不直接把其云 TTS 写进核心 |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) + Kokoro v1.1 | Node 原生多线程、PCM 流、100 个中文音色、同一运行时可承载 STT/VAD | Apache-2.0；模型安装固定 revision 与 SHA-256 | 默认 Local Voice Runtime；浏览器只负责 AudioWorklet/Web Audio，不承载模型推理 |
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
- 本机 TTS 支持关闭、手动与自动模式、100 个内置中文音色、可用的系统中文声音和按角色持久化；不上传回复、不朗读代码或 URL。
- 模型安装器固定模型 revision、文件大小与 SHA-256，保存到 `stateRoot/tts`；本地服务只暴露清单声明的模型文件。模型是可重装运行时依赖，不进入 Backup Bundle。
- 透明双帧图集提供基础嘴部动作，并保证静态模式/减弱动态效果可停止动画。
- Renderer-neutral 的表达与动作合同，为后续 2D/3D 复用。

### V1.1

- 角色设置已经新增形象管理：支持本地 PNG/JPEG/WebP、自包含 VRM 1.0 和普通 GLB 预览；普通 GLB 缺少 `VRMC_vrm`、Humanoid 或身份元数据时不能发布为交互数字人。
- 上传只生成预览，显式发布才创建新的角色 Profile revision；恢复旧形象同样创建新 revision，历史不可改写。
- 世界右栏提供“地图 / 2D / 3D”视图控件；会话切换直接更新 Employee Focus，选择保持在当前世界本地偏好中。
- Renderer Registry 已提供 `sprite-2d`、`vrm-3d` 和供应商无关的 `LiveAvatarRendererPort`。核心没有绑定 HeyGen 或其他云供应商。
- `three`、`@pixiv/three-vrm`、`@pixiv/three-vrm-animation` 位于独立懒加载 chunk，首屏 HTML 不预加载。
- VRM Runtime 已拆分 Motion、Expression、LookAt、Blink、Speech、Animation、Performance 和 Resource Controller；状态来自 `WorldRuntimeSnapshot`，不是 UI 自行推断成功。
- TTS 语音活动驱动基础口型，`VisemeTimeline` 可由未来 TTS Adapter 提供精确时间序列。
- `high / balanced / low / static` 四级质量策略已落地；减弱动态效果、Headless、SwiftShader/软件 WebGL、持续低帧率或初始化失败都会安全回退 2D。

### V1.2（实验功能）

- 可选本地 LivePortrait 服务，使用可商用检测器替换 InsightFace 模型。
- 可选 TripoSR Mesh 生成作业；自动绑定骨骼和脸部表情未通过验证前不得发布为交互数字人。
- 摄像头表情捕捉必须逐次授权，MediaPipe 推理放入 Worker，原始视频默认不落盘。

## 性能门禁

- 数字人模式的 3D/AI 依赖不得进入主首屏 chunk。
- sherpa-onnx、Kokoro、Paraformer 与 Silero 模型只存在于本地 Node Voice Runtime；Web 首屏不得包含其 WASM、模型或预加载引用。Worker 只在 prepare/start 后创建。
- 右侧 Dock 只允许一个重型 WebGL Renderer；进入 VRM Focus 前释放 Overview 的 Pixi Renderer，并用当前主题底图保持视觉连续，退出 Focus 时销毁 Three 的 RAF、Observer、Mixer、材质、纹理和上下文后恢复地图。
- 目标为普通桌面 30 FPS、交互帧 P95 小于 50ms；低性能或不可见页面自动降到 15 FPS 或静态模式。
- VRM/GLB 激活前检查压缩、纹理尺寸和顶点/材质预算；生成任务不得占用会话执行通道。

## 当前构建证据

- 主入口 JavaScript 约 299 kB，主 CSS 约 275 kB；相对引入 VRM 前只增加少量编排代码。
- VRM Runtime 为约 916 kB 的独立懒加载 chunk（gzip 约 232 kB），只在硬件 WebGL 的 VRM Focus 或显式 3D 预览中下载。
- 构建门禁会解析 `index.html`，若首屏预加载 Three/VRM 或懒加载 chunk 超过 950 kB 则失败。
- 浏览器端移除了约 25 MB ONNX WASM 和 Transformers/Kokoro JS。当前实测：MOSS-TTS-Nano CPU Sidecar 冷加载约 4.24s，Warm 首音频 P50 约 0.50s/P95 约 0.54s，RTF P50 约 0.56；Kokoro 继续作为快速降级。Streaming Paraformer 冷加载约 1.49s，测试音频首个 partial 计算约 53ms、Final 约 387ms；稳定语音到 Barge-in 事件约 64ms。
- Playwright 覆盖 Overview → Focus、执行/说话状态、退出/重入、三种视口、减少动态效果和软件 WebGL 降级；Vitest 使用 `three-vrm` 的真实 `VRMLoaderPlugin` 解析发布合同夹具并驱动各 Controller。
