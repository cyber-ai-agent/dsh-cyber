# Conversation Control 与 Runtime Lanes V1

## 目标

聊天输入在角色运行期间仍可继续编辑和发送。消息进入显式队列，用户可以查看等待状态、提前执行下一条、撤销排队消息，或对运行中的 WorkTurn 执行“■ 停止”。队列控制必须先调用服务端 durable queue/control API，前端本地队列只负责乐观显示和 legacy fallback。

```text
发送(queueMode=normal)
        │
        ├─ 同一会话 lane 串行
        ├─ 不同会话可并行
        ├─ 同一角色最多 2 条运行通道，第 3 条显示等待
        └─ stop → server abort → interrupted → “已停止”
```

`ChatTurnQueue` 使用显式队列项和运行 lane，不再以 Promise tail 作为唯一事实。队列项保留 `clientTurnId`、`serverQueueId`、`workTurnId`，因此在首个 token 到达前也能停止或撤销。

## 控制边界

- 发送：聊天请求携带 `queueMode: normal`，服务端返回或恢复 durable queue item。
- 下一条执行：对 queue item 提交 `queueMode: next`，服务端确认后本地才提升顺序。
- 撤销：调用 durable queue cancel API，成功后显示“已撤销”；失败不得只隐藏本地卡片。
- 停止：调用 WorkTurn/AgentRun abort API，收到 interrupted 事实后显示“已停止”；不得用 `AbortController` 或本地状态伪造完成。
- reload：进入世界时读取有界 queue API，恢复等待中、运行中和等待批准的控制卡；已经停止的回合通过持久化聊天通知恢复，不把终态队列无限堆在界面上。不新增 SSE，继续复用现有 `/worlds/:id/live` 与有限刷新。

当前 API 客户端优先使用 `POST/GET /api/worlds/:worldId/chat-queue`、`PATCH/DELETE /api/worlds/:worldId/chat-queue/:queueId` 和 `POST /api/turns/:workTurnId/stop`，并保留 abort/legacy 路径容错。

## Chat 与 Trace 边界

聊天只显示用户消息、角色最终回复、队列控制卡和简短系统状态。tool-call、reasoning、Skill Action、AgentRun/WorkTurn 细节继续进入 World Trace。运行状态统一使用“正在回复中”，停止结果使用“已停止”。

## 验收

1. Web 组件测试覆盖显式 enqueue/promote/remove、输入可写、队列状态和停止文案。
2. Chromium E2E 使用真实 durable queue/control、reload 恢复和真实 abort/interrupted；服务与 Harness 测试验证同角色两个不同会话可并行、第三个会话等待，同一会话内仍保持消息顺序。
3. 1440×900、1920×1080、3840×2160 检查队列卡无横向溢出，并写出 console error/warn/pageerror 日志。
