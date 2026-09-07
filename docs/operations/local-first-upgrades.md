# 本地优先升级与数据保护

DSH Cyber 当前以本机数据为唯一权威源。服务器同步属于未来的可选能力；即使以后启用同步，本地世界、角色、会话、创意工坊项目、Skill 动作和资产仍然拥有独立、可恢复的本地副本。

## 数据与程序严格分离

源码/构建目录只存程序：

```text
<git checkout>/
  packages/
  marketplace/
  docs/
  ...
```

用户数据默认存到源码目录之外：

```text
Windows: %LOCALAPPDATA%\DSH Cyber
macOS/Linux: ~/.dsh-cyber
```

主要持久化内容：

```text
<stateRoot>/
  data/dsh-cyber.sqlite     # 世界、角色、会话、档案、授权、事件等
  worlds/                   # 各世界设置、工作文件、已发布产物和本地世界资产
  assets/                   # 工作区本地资产
  packages/                 # 已安装扩展包
  workshop/                 # 创意工坊项目源与 generated 包
  skills/actions.json       # 已计划/已执行的结构化 Skill 动作
  credentials/              # 本机加密凭据；普通备份默认排除
  runtime/                  # Harness 候选/活动运行时；可重新获取，普通备份排除
  backups/
```

**应用升级只能更新 Git 工作树、依赖和构建产物，不能删除或重建 `stateRoot`。**

## 推荐：更新到最新稳定版本

Web 设置中的“应用更新”可完成同一流程。它只在当前源码位于干净的 `main` 分支、远端为 `origin/main` 且更新可以快进时启用；安装前会创建完整备份，并在隔离工作树中完成依赖安装和构建。更新成功后重启 DSH Cyber 即可使用新版本。

命令行流程仍适合开发环境和需要手动检查每一步的用户：

运行中的实例可以在 Web 设置中创建备份。使用下列离线命令前，先正常关闭使用同一数据目录的服务；包括旧版本服务也必须关闭。命令行的备份、诊断、导出、清理及恢复会获取数据目录独占锁，避免与另一进程或恢复作业交错读写。

在项目源码目录执行：

```bash
# 1. 先备份所有可移植本地创作数据
pnpm dsh-cyber backup

# 2. 拉取最新稳定代码
# 如果本地有未提交的源码修改，请先 commit/stash；不要用清理数据目录的方式处理冲突。
git fetch origin
git switch main
git pull --ff-only origin main

# 3. 按锁文件安装并重新构建
pnpm install --frozen-lockfile
pnpm build

# 4. 用原来的 stateRoot 做升级后健康检查
pnpm dsh-cyber doctor

# 5. 启动最新版本；默认会继续读取原本的本地世界和数据
pnpm dsh-cyber web
```

默认数据目录不在 Git 仓库中，因此上述 `git switch`、`git pull`、`pnpm install` 和 `pnpm build` 不会触碰用户创作数据。

内置角色蓝图的 `id + version` 也是持久化身份。启动时已经存在的同版本蓝图保持本地权威，程序只补充缺失版本；发布方修改内置蓝图内容时必须提升版本号，不能覆盖旧版本或要求用户重建角色。

## 开发分支用户

需要跟随某个开发分支时，只替换 Git 分支命令，其余步骤完全相同。例如：

```bash
pnpm dsh-cyber backup

git fetch origin
git switch feat/creative-world-platform-v1
git pull --ff-only origin feat/creative-world-platform-v1

pnpm install --frozen-lockfile
pnpm build
pnpm dsh-cyber doctor
pnpm dsh-cyber web
```

开发分支可能包含 schema migration。migration 必须由应用版本化执行；禁止通过删除数据库、世界目录或 Workshop 项目来“解决”升级问题。

## 使用自定义数据目录

如果一直使用显式 `--data-dir`，升级后必须继续使用同一个路径：

```bash
pnpm dsh-cyber backup --data-dir /path/to/my-dsh-cyber-data

git fetch origin
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm build

pnpm dsh-cyber doctor --data-dir /path/to/my-dsh-cyber-data
pnpm dsh-cyber web --data-dir /path/to/my-dsh-cyber-data
```

推荐把自定义数据目录放在 Git 仓库之外。如果历史上使用了 `--data-dir ./data`，升级时不要运行会清理未跟踪文件的命令，例如：

```text
git clean -fd
git clean -fdx
```

更不要删除 `data/`、`worlds/`、`workshop/`、`skills/` 来处理普通代码升级。

## 备份包含什么

当前 `backup` 生成 `.dshbackup` 本地 Bundle，包含：

- SQLite 数据库；
- `worlds/` 世界文件、设置、`exports/artifacts/` 已发布产物和非缓存资产；
- `assets/`；
- `packages/`；
- `workshop/` 创意工坊项目源与生成包；
- `skills/` 结构化 Skill 动作与计划。
- `integrations/` 持久化集成配置（凭据仍由独立的凭据存储管理）。

普通 Bundle 有意排除：

- `credentials/`：模型/第三方服务凭据保持本机加密存储，不进入普通备份；
- `runtime/`：Harness 运行时可以重新校验/下载；
- `worlds/*/cache`：可重建缓存；
- `backups/`：避免备份递归包含自身。

因此升级前的 Bundle 用于保护**用户创作与运行事实**，而不是复制程序和缓存。

## 离线恢复

先关闭该数据目录对应的服务并备份现状，再恢复目标备份：

```bash
pnpm dsh-cyber backup
pnpm dsh-cyber restore --input /path/to/verified.dshbackup --force
pnpm dsh-cyber doctor
pnpm dsh-cyber web
```

备份先写临时文件并完整读回校验，成功后才发布正式文件。活跃文件发生可检测的变更时备份失败，可在停止相关写入后重试；这不是跨数据库与外部编辑器的原子时间点快照。

恢复先验证完整包，再通过恢复日志切换纳入备份的目录。提交前的失败会尝试恢复旧目录；如果回退也失败，将保留恢复日志及救援副本，下次恢复或服务启动会先处理未完成事务。不要手工删除恢复事务目录，也不要删除 `.state-root-lease.sqlite`；该文件仅用于操作系统文件锁，进程退出后锁自动释放，不包含用户业务数据。

## 升级后检查

`doctor` 至少要确认：

```bash
pnpm dsh-cyber doctor
```

然后在 Web 中检查：

1. 原世界仍然存在；
2. 原角色、档案、会话和关系仍然存在；
3. 创意工坊项目仍能打开；
4. 已安装扩展包仍能识别；
5. 已计划的 Skill 动作仍保留，并在执行前重新校验角色授权；
6. 世界设置、附件和本地资产仍能读取。
7. 聊天中的产物卡仍能打开，产物版本和格式化阅读器仍能读取对应文件。

只要用户继续使用同一 `stateRoot`，应用升级不得要求重新创建这些内容。

## Harness 更新与应用更新是两条链

应用源码更新：

```text
Git / dependency / build
        ↓
DSH Cyber program
        ↓
读取原 stateRoot
```

底层 Harness 更新：

```text
candidate Harness
   ↓ compatibility check
   ↓ contract test
   ↓ real canary
   ↓ human approval
active runtime pointer
```

Harness 更新失败时使用：

```bash
pnpm dsh-cyber runtime-rollback
```

该操作现在会先创建完整的本地数据 Bundle，再恢复内置 Harness；它不能删除用户世界或 Workshop 项目。

### 启动时的运行时版本闸门

兼容矩阵会继续列出更老的 Harness 版本（候选校验需要它们），但当前构建的启动路径只能驱动它所固定的那一个版本。因此启动时会把「已激活的运行时」与固定版本比对，而不是与矩阵比对：

- 版本一致：正常启动；
- 版本不一致（包括指针写着固定版本、但候选目录里其实是更老的树）：直接 fail closed，不进入首个回合。错误里会写清当前激活的版本、需要的版本，以及两条升级路径（`runtime-rollback` 恢复内置运行时，或先 `runtime-check` 校验一个匹配版本的候选再重新激活）。

这样处于旧运行时的用户拿到的是可执行的升级说明，而不是启动后在第一个回合遇到看不懂的模型错误。

## 未来服务器同步

未来引入服务器同步时遵循：

```text
Local state = authority / working copy
Cloud sync  = optional encrypted replica
```

同步层必须通过版本、冲突策略和可审计操作与本地状态对接。断网、账号退出、服务器不可用或同步功能关闭，都不能导致本地创作世界失效。
