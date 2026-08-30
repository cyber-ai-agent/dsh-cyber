# ADR 0009：Voice、Context 与 Avatar Runtime V2

- 状态：Accepted
- 日期：2026-08-31
- 替代/扩展：`digital-human-avatar-runtime-v1.md` 的语音流、上下文预算与 3D 入口部分

## 背景

DSH Cyber 已经具备本地 STT/VAD、MOSS/Kokoro TTS、角色级语音档案、2D/VRM Renderer、角色长期记忆和世界知识检索。当前主要问题不是缺少更多按钮，而是三条运行链路缺少统一的性能与演进边界：

- MOSS ONNX 内部虽做增量 codec decode，Sidecar 却在返回前重新拼成整段 PCM；
- 长期记忆以里程碑和字符数预算注入，缺少 thread checkpoint、token budget、滚动摘要、缓存与命中诊断；
- 地图/2D/3D 已有入口，但角色没有 VRM 时仍可点击 3D，形象管理入口与运行准备状态不够直接。

V2 的目标是复用既有 Conversation、Agent Runtime、World Runtime 与 Renderer Registry，而不是再造 Voice Agent、Memory Agent 或 3D World 三套平行系统。

## 决策一：语音是 Agent Runtime 的流式输入输出层

```text
LLM text.delta
  -> StreamingSentenceChunker
  -> TextToSpeechProvider
  -> AudioChunk AsyncIterable
  -> DSHV PCM stream
  -> Web Audio queue + speech activity
  -> VRM/Sprite speech controller
```

- MOSS Sidecar 直接发送每次 codec 增量解码得到的 PCM，不再等待完整波形或 WAV。
- Sidecar 协议使用 `audio(sequence, sampleRate, pcm)` 与独立 `done(sequence)`；Node Provider 将 `done` 映射为零长度 `final` 帧。
- Kokoro 与 MOSS 共用宿主 `AsyncQueue`，Provider 只负责模型协议，HTTP 路由和 UI 不知道模型实现。
- Barge-in 继续杀掉当前 TTS 进程/请求和 Audio Queue，但不自动取消 Agent WorkTurn。
- 单次播报被打断后立即在后台重建并预热 MOSS Sidecar；应用退出、模型删除和显式 dispose 才保持关闭，避免下一轮重新承担完整冷启动。
- MOSS 保持默认自然语音包；未安装、失败或不满足性能策略时降级到 Kokoro，再降级到系统中文声音。
- 音频帧、模型和 Python Runtime 不进入首屏；模型只在语音设置、试听、自动播报或 Voice Mode 预热时加载。

### 性能门禁

- Warm TTFA：P50 < 600ms，P95 < 800ms；
- RTF P95 < 1；
- 未启用语音时不加载 MOSS/Kokoro，不创建 AudioContext；
- 推理只在 Sidecar/Worker，Node/React 主线程不得出现语音推理 Long Task；
- Benchmark 必须报告 cold start、TTFA、chunk 数、潜在断流、RTF、进程树 RAM 和整机 CPU 占比。

## 决策二：上下文由预算规划器组合，不由各服务无限拼接

DSH 保留现有事实源，但在 Harness 调用前增加 Provider-neutral 的 `ContextBudgetPlanner`：

```text
固定层：system + persona + authority + permission + skill recipes
工作层：当前用户请求 + 最近消息窗口 + 当前 WorkTurn/approval facts
压缩层：thread rolling summary/checkpoint
检索层：employee episodic memory + world knowledge
保留层：模型输出预算 + tool/result safety margin
```

- 所有预算以 token 估算为主，字符数只作为无法获得 tokenizer 时的保守 fallback。
- 短期记忆按 conversation/thread 隔离，长期记忆按 employee/world/scope 隔离；私聊记忆不得进入群聊。
- 当软阈值到达时后台生成滚动摘要；硬阈值到达时必须压缩或裁剪，不能把超长 Prompt 交给 Provider 失败。
- 摘要是有来源范围和版本的 checkpoint，不覆盖原始消息；需要时可以从 SQLite 重建。
- 检索缓存键至少包含 `scope + sourceRevision + normalizedQuery + budgetProfile`，消息/里程碑/知识 revision 改变后自动失效。
- 先使用本地关键词/BM25/FTS 热路径；向量或模型重写是可选 Adapter，不进入每轮必经路径。
- 每轮记录 `inputBudget / usedTokens / cacheHit / memoriesConsidered / memoriesInjected / summaryVersion / trimReason`，详细数据只进入诊断和轨迹，不塞进聊天。

参考实现只借鉴边界：LangGraph 区分 thread checkpoint 与 long-term store，并提供 trim/summary；Letta 把长期可见资料建模为可挂载 memory blocks；OpenHands Condenser 区分 soft/hard condensation。DSH 不引入它们的 Agent loop。

## 决策三：地图、2D、3D 是同一角色焦点的 Renderer 切换

当前入口位于世界右栏的 `地图 / 2D / 3D` 分段控件；选择 2D 或 3D 后，点击左侧私聊会自动切换到该角色，群聊则将最新发言者置于中心并展示其他参与者。

V2 交互收敛为：

1. `地图`：世界概览与设施交互；
2. `2D`：所有角色立即可用的低成本 Focus；
3. `3D`：角色已发布 VRM 时一键进入；没有 VRM 时不显示空白失败，而是在原位展示“添加 3D 形象”，直接打开该角色的形象管理；
4. 会话切换只更换 Focus 角色，不要求重复选择 2D/3D；
5. hover/聚焦 3D 控件只预取轻量能力和资源清单，真正 Three/VRM chunk 在确认进入后加载；
6. 3D 加载期间保留 2D Sprite bridge，失败、低 FPS、软件 WebGL、减弱动态效果自动回退 2D；
7. 角色档案保存形象 revision 与能力清单，世界和会话不保存 Renderer 私有状态。

VRM 1.0 继续作为首选 3D 角色格式，因为其规范直接覆盖 humanoid、表情、a/i/u/e/o 口型、视线和 SpringBone。TalkingHead/HeadAudio 只作为 AudioWorklet、viseme queue 和动作调度参考，不替换现有 Renderer Registry。

## 防止代码继续膨胀

- `EmployeeFocusMode` 只做页面组合，语音设置、播放控制、模型包管理和 Avatar 模式状态逐步迁移到独立 feature/controller；
- Provider 不 import React、SQLite 或具体 HTTP 路由；
- `ContextBudgetPlanner` 不读取供应商私有 token API，通过 TokenEstimator Port 获取估算；
- Renderer Adapter 不改变会话、任务、产物或世界事实；
- 新能力必须有合同测试、性能门禁和浏览器真实入口测试，禁止隐藏按钮或脚本点击冒充完成。

## 分阶段交付

### Phase A：Voice Streaming

- MOSS codec chunk 协议、共享 AsyncQueue、零长度 final 帧；
- TTFA/chunk/断流/RAM/CPU Benchmark；
- 浏览器连续播放、停止、Barge-in 和 2D/VRM speaking 验收。

### Phase B：Context Budget + Cache

- ContextBudgetPlanner、TokenEstimator、预算档位和诊断；
- thread rolling summary/checkpoint；
- memory/knowledge retrieval cache 与 revision 失效；
- 长会话性能与隐私隔离 E2E。

### Phase C：Avatar Entry V2

- 3D 能力状态与“添加 3D 形象”原位入口；
- 角色形象管理直达、预热策略和加载进度；
- Renderer 控制器从 EmployeeFocusMode 拆分；
- 2D/3D/地图跨会话、群聊和低配降级 E2E。

## 参考

- [OpenMOSS/MOSS-TTS-Nano](https://github.com/OpenMOSS/MOSS-TTS-Nano)
- [LangGraph memory](https://langchain-ai.github.io/langgraph/how-tos/memory/manage-conversation-history/)
- [OpenHands context condenser](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/context/condenser/base.py)
- [Letta memory blocks](https://docs.letta.com/tutorials/attaching-detaching-blocks/)
- [VRM features](https://vrm.dev/en/vrm/vrm_features/)
- [met4citizen/TalkingHead](https://github.com/met4citizen/talkinghead)
- [met4citizen/HeadAudio](https://github.com/met4citizen/HeadAudio)
