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
