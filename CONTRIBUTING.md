# 参与 DSH Cyber 共创

感谢你参与 DSH Cyber。仓库当前处于 **Pre-Alpha / Creative Platform V1** 快速演进阶段。贡献应优先保持：本地优先、明确领域边界、可审计、最小权限、真实执行证据和可复用组件。

> 本仓库采用 PolyForm Noncommercial License 1.0.0。代码公开可读、可参与社区共创，但该许可证不是 OSI 认证的 Open Source License。对外请准确描述为 source-available / 社区共创项目。

## 开始之前

请先阅读：

- [`README.md`](./README.md)
- [`docs/technical-report.md`](./docs/technical-report.md)
- [`docs/development/architecture-guidelines.md`](./docs/development/architecture-guidelines.md)
- [`docs/development/ci-strategy.md`](./docs/development/ci-strategy.md)
- [`AGENTS.md`](./AGENTS.md)

大型领域变更建议先讨论 contract / boundary，再进入实现。

## 事实来源

当文档、示例和实现不一致时，应同时核对：

1. `packages/contracts/src` 的公开类型与 schema；
2. 对应 parser / service / persistence；
3. 单元与集成测试；
4. 浏览器 E2E（当该场景已经进入稳定验收层）；
5. ADR / architecture docs / roadmap。

路线图不是已实现能力。讨论稿也不能单独改变 HTTP API、SQLite schema、包 schema 或 World Runtime contract。

## 架构贡献规则

### World / Character / Skill / Harness 分离

```text
World != Character != Skill != Harness
```

禁止：

- 根据角色显示名称写运行时业务分支；
- 在核心 Skill Runtime 中增加供应商专属 `if/else`；
- 把 `requestedSkills` 当成 `skillGrants`；
- 让 UI 动画或模型自然语言代替真实执行结果；
- 绕过 PackageManager / Harness Adapter 创建第二条隐藏运行路径。

新增供应商能力应实现稳定 Adapter；新增复杂 UI 应拆 feature/component/model 边界，不继续扩大 `App.tsx`。

## Character 自定义规则

用户当前保存的 Character Identity / Persona / Relationship / Embodiment / Memory 是运行时事实。

如果某个角色从“秘书模板”创建，用户后来把它改成猫、伙伴、酒馆老板或其他身份，运行时不能继续根据旧模板名字偷偷恢复“秘书”设定。

模板是 construction material，不是永久隐藏人格。

## 本地数据规则

程序目录与 `stateRoot` 必须分离。

新增持久化目录时同时考虑：

- schemaVersion；
- migration；
- `.dshbackup`；
- restore；
- failure behavior。

### 当前 Pre-Alpha

Creative Platform V1 兼容基线正式宣布前，如果开发期旧格式严重妨碍正确架构，可以进行明确的 clean refactor，不要求为了尚未发布给真实外部用户的数据快照永久保留大量兼容补丁。

### 兼容基线之后

持久化格式变化必须使用 versioned migration；普通升级不得要求用户删除 `stateRoot`。

## 开发流程

1. 从最新 `main` 或当前约定的集成分支创建范围明确的分支：`feat/...`、`fix/...`、`refactor/...`、`docs/...`。
2. 大型 contract / persistence / permission 变化优先补 ADR 或 architecture note。
3. 保持 commit 可审查，不混入本地数据库、密钥、私有日志、临时构建产物。
4. Pull Request 说明：目标、边界、实际验证、仍未验证的内容。
5. Required CI 通过后可以继续集成；准备把大型 Draft PR 标记为 Ready 或合并 `main` 时，再运行当前阶段要求的完整浏览器验收。

## CI 与测试

当前 Pre-Alpha Required CI：

```bash
pnpm typecheck
pnpm test
```

完整 Chromium E2E 当前用于：

- `main` push；
- nightly；
- manual dispatch；
- 大型重构准备进入 Ready / merge 前的阶段验收。

本地完整验证仍可运行：

```bash
pnpm test:e2e
pnpm verify
```

测试应尽量验证业务合同：角色是否创建、会话是否持久化、Skill 是否越权、重启是否恢复。避免把所有测试绑定到“左侧第几个按钮”或固定 DOM 排列。

详见 [`docs/development/ci-strategy.md`](./docs/development/ci-strategy.md)。

## UI / Visual QA

影响核心界面的改动至少检查：

- 1440×900；
- 1920×1080；
- 3840×2160；
- 控制台 error/warn；
- 文字可读性；
- 世界画面填充；
- 弹窗遮挡/重叠；
- 关键入口是否符合当前信息架构。

当前信息架构：

```text
Topbar: Creative Workshop / Market / Runtime / Settings
Left: Conversations only
Right: World / Dossier
```

旧 E2E 如果仍要求“左侧添加角色”“文件 Tab”等废弃入口，应更新测试，不要恢复旧产品结构。

## 市场 / MOD 贡献

本地开发不需要手算或手改哈希。修改主题、角色或插件后运行：

```bash
pnpm package:prepare marketplace/themes/official-cyber-nocturne
```

它自动同步新增/删除文件、文件哈希和已有的内容摘要；不会改变包的名称、能力和授权声明。连续开发可以开启监听：

```bash
pnpm package:prepare <包目录> --watch
pnpm package:prepare <包目录> --check
```

`--check` 只检查，不写文件；清单需要更新时返回非零退出码。编辑器目录、Git 元数据、隐藏本地配置和 `node_modules` 会被排除，不必为打包删掉它们，也不会被复制到安装包中。

### 本地开发版本（`--dev`）

已安装的版本是不可变的：同一个版本号换了内容会被安装流程直接拒绝，这样别人已经批准安装的那份文件不会被悄悄改写。本地反复调试不需要每次手改版本号：

```bash
pnpm package:prepare <包目录> --dev
```

- 发行版本 `1.0.0` 会变成明确标记的 `1.0.0-dev.1`，再次改动后变成 `1.0.0-dev.2`，依此类推。
- 没有任何改动时重复执行不会再加一个版本；`--dev` 不能和 `--check`、`--watch` 同时使用（前者只读，后者会在每次保存时生成新版本）。
- 开发版本是普通版本号，安装到自己的目录，`1.0.0` 的安装记录和文件保持原样；世界里当前生效的版本会指向新装的开发版本。
- 准备发布时，把版本号手动改成下一个正式版本（例如 `1.0.1`）再运行一次不带 `--dev` 的 prepare。

市场页对本地扩展的诊断按原因分别给出，并附上对应命令：缺少已声明的文件、目录里有未声明的文件、文件哈希待更新、内容摘要待重算、清单字段无效、声明了不会打包的隐藏文件或开发目录，以及“已安装版本内容不同”。看到最后一条时用 `--dev`。

普通改动只需运行相关测试；不需要为了修改一个主题或文案重新执行所有集成和浏览器测试。涉及持久化、权限、执行流程或主要界面的改动，再补对应的回归证据。

市场包请先阅读：

- [`docs/community/package-ecosystem.md`](./docs/community/package-ecosystem.md)
- [`docs/community/world-theme-authoring.md`](./docs/community/world-theme-authoring.md)
- [`docs/community/employee-blueprint-authoring.md`](./docs/community/employee-blueprint-authoring.md)
- [`docs/community/plugin-authoring.md`](./docs/community/plugin-authoring.md)

包必须声明文件、哈希、许可证、发布者、capabilities 和 data egress。发现一个包不等于信任它；安装一个包也不等于批准它执行所有外部动作。

## 安全与隐私

- 不提交 `.env`、API key、Cookie、私有会话、数据库、`.local-data`、`.private`、用户工作区或真实凭据。
- 不使用符号链接、绝对路径、`..`、隐藏文件绕过包边界。
- Capability 只申请真实需要的最小集合。
- 外部副作用必须可追踪到具体 Action 和授权来源。
- 漏洞披露不要在公开 issue 中附真实凭据或可直接利用的用户数据。

## 许可证与署名

提交贡献即表示你有权提交相关代码、文档和资产，并同意贡献按仓库 [`LICENSE`](./LICENSE) 分发。第三方资产必须提供可核验来源和兼容许可证。
