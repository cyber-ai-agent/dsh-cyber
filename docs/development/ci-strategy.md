# CI Strategy

DSH Cyber 当前处于 Pre-Alpha / 架构快速演进期。CI 的目标是尽早发现真实回归，同时避免把尚未稳定的信息架构和 UI 细节变成高成本的开发阻塞。

## 分层原则

### L1 — Required PR CI（快速门禁）

每个 Pull Request 和 `main` push 都运行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:migration
pnpm test:schema
pnpm exec playwright install --with-deps chromium
pnpm exec playwright test --config playwright.smoke.config.ts
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
- 会话草稿与附件归属、刷新恢复、上传部分失败和清空草稿的核心浏览器行为。

核心 Smoke 使用确定性本地运行时，不依赖外部模型或密钥。失败时保留截图、trace 和控制台记录，CI 上传 `core-browser-smoke` 工件并保留 7 天。必须在浏览器检查成功后才发布 `CI / required` 状态。

### L2 — Opt-in Full E2E

完整浏览器套件独立于必过核心 Smoke。`full-e2e.yml` 默认运行于：

- `main` push；
- nightly schedule；
- GitHub Actions 手动触发。

对需要在合并前检查浏览器回归的 PR，添加 `run-full-e2e` label 即可启动同一 workflow；未添加 label 的 Draft/开发 PR 会被快速跳过。

它覆盖：

- 首次启动；
- 创建世界；
- canonical 私聊；
- 创意工坊创建世界；
- 重启恢复本地状态。
- 同员工双会话和 SQLite lease；
- Task → 多角色执行 → Deliverable → Review → 新版本；
- Package/Artifact 核心闭环。

官方 CC0 avatar base pack 的重建、运行时解析和 byte-for-byte 工作树校验也在这一层执行。

Pre-Alpha Draft PR 不要求 Full E2E 每次提交都通过。准备把大型重构 PR 标记为 Ready for review 或准备合并 `main` 时，应添加 label 或手动运行完整 E2E 并处理仍然有效的回归。

核心 Smoke 随稳定产品路径扩充；完整 Chromium 回归仍保留在更慢的独立层。

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
| Pre-Alpha（当前） | Typecheck + Unit/Integration + Migration/Schema + 核心 Smoke E2E |
| Alpha | 扩充核心黄金路径 Smoke |
| Beta | + Full E2E |
| Stable | + Migration + Backup/Restore + OS matrix |
| Release | + Real Harness Canary + package/release validation |

CI 严格度应随用户规模和兼容性承诺提高。当前阶段允许为了清晰的领域边界进行较大重构；一旦 Creative Platform V1 被声明为本地数据兼容基线，后续结构变化必须使用 versioned migration，而不能要求用户清空数据目录。
