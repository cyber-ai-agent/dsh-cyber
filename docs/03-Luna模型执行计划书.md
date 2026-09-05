# DSH Cyber 模型执行与交互优化记录

## 2026-08-25

本次更新固化以下可复用边界：

- 世界画布必须跟随实际宿主容器尺寸更新。左右面板变化后，Pixi renderer、交互区域和 cover camera 需要在同一次 ResizeObserver 回调中重新计算。
- 模型连接顺序固定为服务地址与 API 密钥优先，模型目录发现与搜索选择随后进行。手动填写模型 ID 是显式备用方式。
- 全局应用锁同时覆盖前端和服务端 API。密码只保存 scrypt 派生哈希，服务重启后不会沿用旧解锁会话。
- 每个世界只有自己的管理员身份和管理边界。管理员职责不能传播到其他世界。
- 创意工坊使用四步引导流程，依次处理世界、角色、权限与 Skills、创建确认；高级内容按需展开。
- 设置和重型工作台功能通过按需加载控制首屏体积。主入口构建产物保持在 400 kB 以内，新增重型页面应继续独立拆包。

验证命令：

```bash
pnpm typecheck
pnpm test
pnpm exec playwright test e2e/workbench.spec.ts
```

视觉验收覆盖 1440×900、1920×1080、3840×2160，并记录页面 error 与 warning。

## 2026-08-30

数字人 V1.1 与世界连续交互更新：

- 世界 Overview 与 Employee Focus 是同一产品路径；地图角色聚焦后进入 Focus，不再保留独立地图/数字人 Tab 或默认行动舱。
- 本地图片、VRM 1.0 与普通 GLB 使用上传预览、显式发布、角色 Profile revision 和不可改写回滚历史；普通 GLB 只能预览。
- Three、three-vrm 与 three-vrm-animation 只在硬件 WebGL 的 VRM Focus 中按需加载，首屏不预加载。
- Pixi 与 Three 不得在切换帧争抢 WebGL：Focus 先展示 Sprite，释放 Overview 后延迟探测；能力探测不调用 `WEBGL_lose_context`，软件渲染和减弱动态效果直接降级静态 2D。
- VRM 运行状态只来自 `WorldRuntimeSnapshot`，语音只消费最终回复；失败、知识和产物状态不能由动效伪造。

验证命令：

```bash
pnpm typecheck
pnpm test
pnpm test:migration
pnpm test:smoke
pnpm exec playwright test e2e/digital-human-world.spec.ts
```

视觉验收继续覆盖 1440×900、1920×1080、3840×2160；构建门禁要求主入口不引用 Three/VRM，VRM 懒加载 chunk 不超过 950 kB。

### Employee Focus 可见入口修正

- 原数字人 E2E 使用隐藏按钮脚本触发，不能证明真实用户可以进入；该验收方式已废止。
- 世界 HUD 的“当前会话”现在直接展示可点击的角色与岗位，点击后进入对应 Employee Focus；地图人物点击继续作为空间快捷方式。
- E2E 必须对真实入口执行 `visible + enabled + 普通 click`，并验证 Focus 和返回路径；禁止 `force`、隐藏镜像和 `evaluate().click()`。
- 已在本地真实股票分析团队数据页面完成点击验证，控制台 error/warn 为 0。

### 中文本地语音与连续角色视图

- 世界右侧只保留一个 `地图 / 2D / 3D` 显示方式；用户选择 2D 或 3D 后，切换私聊会直接跟随到对应角色，群聊按最新回复者居中并展示其他参与角色。
- 中文语音不再依赖操作系统是否安装中文声音。默认安装 sherpa-onnx + Kokoro 82M int8，提供 100 个中文音色；系统语音仅作为零模型 fallback。
- Streaming Paraformer、Silero VAD、AudioWorklet、WebSocket Binary PCM、Partial/Final、Conversation/WorkTurn 复用和 Barge-in 已形成同一本地 Voice Runtime；没有第二套 Agent Runtime。
- 语音模式和音色按角色保存。回复 `text.delta` 经 SentenceChunker 与 TTS Queue 提前播报；Web Audio Analyser 的真实 PCM RMS 驱动 VRM 口型。
- 安装器固定 revision、大小和 SHA-256；模型不进普通备份或 Web 首屏。Worker Thread 首次 prepare 才创建，未启用语音时不申请麦克风、不创建 AudioContext。

验证命令：

```bash
pnpm tts:install
pnpm typecheck
pnpm test
pnpm exec playwright test e2e/digital-human-world.spec.ts
```

## 审计整改记录 v2026.09.05-01

新增运行生命周期工程护栏，原因：审计 F01–F03 确认重试 finally 提前清理、角色级恢复扩大故障域、模型代际创建竞争。落实有界尝试、会话级重置、代际租约与任务身份清理；执行状态及验收见 `development/audit-remediation-2026-09-05.md`。本文不记录凭据或用户数据。

## 审计整改记录 v2026.09.05-02

新增备份发布、恢复日志及独占锁护栏，原因：F04/F05 的失败替换和同尺寸变更风险；项目测试另复现 Windows 只读 fsync 的 EPERM 与大分片正则栈溢出。保持流式分片、旧 schema 可恢复、凭据排除与失败救援副本，具体证据见整改执行计划。
