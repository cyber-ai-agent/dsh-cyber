# CI Strategy

DSH Cyber 当前处于 Pre-Alpha / 架构快速演进期。CI 的目标是尽早发现真实回归，同时避免把尚未稳定的信息架构和 UI 细节变成高成本的开发阻塞。

## 分层原则

### L1 — Fast Required CI

每个 Pull Request 和 `main` push 都运行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

这层是当前唯一 Required Gate，保护：

- TypeScript contracts；
- domain/service 边界；
- persistence；
- Harness adapter；
- World Runtime / Simulation；
- Skill Runtime；
- Workshop service；
- migration / backup 等核心逻辑。

### L2 — Smoke E2E

计划在 Creative Platform V1 稳定后加入。只覆盖少量核心用户路径：

- 首次启动；
- 创建世界；
- canonical 私聊；
- 创意工坊创建世界；
- 重启恢复本地状态。

目标运行时间不超过数分钟，并在进入 Alpha 后升级为 Required。

### L3 — Full Chromium E2E

完整 Playwright 回归目前运行于：

- `main` push；
- GitHub Actions 手动触发；
- nightly schedule。

Pre-Alpha Draft PR 不要求 Full E2E 每次提交都通过。准备把大型重构 PR 标记为 Ready for review 或准备合并 `main` 时，应手动运行完整 E2E 并处理仍然有效的回归。

### L4 — Release Validation

进入 Beta / Stable 后逐步增加：

- backup / restore；
- versioned migration；
- Windows / macOS matrix；
- Harness candidate contract test；
- real-model canary；
- package compatibility；
- release artifact validation。

## 测试产品契约，减少布局耦合

E2E 应验证：

- 用户能完成某个业务动作；
- 角色、会话、世界、Skill 状态正确持久化；
- 权限与真实副作用边界正确；
- 重启后仍可恢复。

尽量避免把测试绑定到：

- “左侧第 3 个按钮”；
- 某个固定 Tab 顺序；
- 已经废弃的入口文案；
- 与业务无关的 DOM 层级。

协作类 E2E 可以通过公开 API 准备角色，再专门保留少数 UI E2E 验证“档案 → 新增角色”这类入口。这样 UI 重构不会让所有协作测试同时失效。

## 阶段规则

| 阶段 | Required Gate |
| --- | --- |
| Pre-Alpha（当前） | Typecheck + Unit/Integration |
| Alpha | + Smoke E2E |
| Beta | + Full E2E |
| Stable | + Migration + Backup/Restore + OS matrix |
| Release | + Real Harness Canary + package/release validation |

CI 严格度应随用户规模和兼容性承诺提高。当前阶段允许为了清晰的领域边界进行较大重构；一旦 Creative Platform V1 被声明为本地数据兼容基线，后续结构变化必须使用 versioned migration，而不能要求用户清空数据目录。
