# DSH Cyber Windows 桌面预览版

桌面版复用同一套本地服务、Web 工作台和 `%LOCALAPPDATA%\DSH Cyber`。窗口由 Electron 管理，模型、角色、会话、任务和文件仍由 DSH Cyber 的本地服务与 `stateRoot` 持有。设计参考了 [DeepSeek Harness Desktop 的窗口与后台任务行为](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)，但不引入上游账号、插件或更新状态作为本产品的数据源。

当前预发布版本：`0.1.0-preview.1`，适用于 Windows x64。

| 下载 | 用途 |
| --- | --- |
| [安装包](https://github.com/cyber-ai-agent/dsh-cyber/releases/download/desktop-v0.1.0-preview.1/DSH-Cyber-Setup-0.1.0-preview.1-win-x64.exe) | 每用户安装，提供开始菜单入口。 |
| [便携版 ZIP](https://github.com/cyber-ai-agent/dsh-cyber/releases/download/desktop-v0.1.0-preview.1/DSH-Cyber-Portable-0.1.0-preview.1-win-x64.zip) | 解压后运行 `DSH Cyber.exe`；用户数据仍留在默认数据目录。 |
| [SHA-256 校验文件](https://github.com/cyber-ai-agent/dsh-cyber/releases/download/desktop-v0.1.0-preview.1/SHA256SUMS.txt) | 下载后核对安装包或便携包完整性。 |

当前支持 Windows x64：单实例、独立本地 Node 运行时、随机回环端口、托盘恢复、关闭窗口后后台运行、退出时停止本地服务。首次关闭窗口会说明后台行为。明确退出会提示正在运行的任务可能中断，计划任务在应用完全退出后不会执行。应用首次以某个桌面版本打开已有数据库前，会用现有 CLI 生成并验证完整 Backup Bundle；失败则拒绝启动。新建空数据目录不创建空备份。安装、更新和卸载程序不会删除 `stateRoot`。

桌面渲染进程启用沙箱、上下文隔离和受限 CSP；只在拥有的本机服务地址内导航。外部 HTTP(S)/邮件链接交给系统浏览器，其他协议被拒绝。麦克风权限只允许本应用页面请求。桌面端没有第二套业务 API 或数据库。

## 构建与运行

在仓库根目录安装依赖后：

```bash
pnpm install --frozen-lockfile
pnpm desktop:dev
pnpm desktop:package:win:dir
pnpm desktop:package:win:installer
```

`desktop:dev` 使用仓库忽略的 `.private/desktop-dev-state`，不会启动在正式用户数据上。目录包位于 `apps/desktop/.desktop-build/artifacts/win-unpacked/`；安装包位于同级 `DSH Cyber Setup <version>.exe`。打包前会构建 Web 与服务，整理不指向源码的生产依赖，放入独立 Node，并在隔离目录验证“启动 → 健康检查 → 关闭 → 备份”。这两个构建命令只生成本机产物，不发布或安装。上传到 Releases 前，运行 `pnpm --filter @dsh-cyber/desktop release:prepare` 生成便携 ZIP、版本化安装包名称与校验文件。

安装包目前**未签名，也没有自动更新**。更新已安装预览版时，先从托盘退出旧进程，再运行新安装包；新版本第一次启动会先做本地 Backup Bundle。默认数据目录保持 `%LOCALAPPDATA%\DSH Cyber`，凭据不会写入安装目录或普通备份。安装器显示仓库的非商业许可证，包内也包含 `LICENSE`。

## 发布维护

每次桌面版更新都先修改 `apps/desktop/package.json` 的版本，并在中英文 README、本文的三个直达链接和 `apps/desktop/releases/<version>.md` 同步更新。`check-release-links.mjs` 会核对文档版本与资产名称；Windows CI 会验证独立目录包。相关 PR 合并并通过检查后，**只在该提交上**创建 `desktop-v<version>` 标签。`windows-desktop-release.yml` 随标签构建安装包和便携 ZIP、验证备份与解压后的启动、生成 SHA-256，先上传到草稿 Release，确认资产大小与摘要后再发布为预发布版。不要复用旧标签覆盖已经发布的安装包；失败时修复后重跑草稿，已发布版本的问题用新版本处理。

## 验证

```bash
pnpm exec vitest run apps/desktop/tests/runtime.test.ts packages/cli/tests/cli.test.ts
pnpm exec playwright test e2e/desktop-preview.spec.ts
```

浏览器 E2E 在 Windows 上使用隔离数据目录，验证真实 Electron 窗口、托盘式隐藏后的服务存活、明确退出后的服务停止，以及目录包首次打开已有世界时创建备份。Linux CI 会跳过仅限 Windows 的窗口用例，CLI 与运行时服务测试仍可执行。

视觉验收（Chromium/Electron，当前世界默认视图）：

| 视口 | 地图与空白 | 文字、语言与操作 | 控制台 |
| --- | --- | --- | --- |
| 1440×900 | 世界视图铺满右侧容器，无黑边；聊天区空白为无消息状态 | 中文文案一致，正文与按钮可读 | 无新增 error/warn |
| 1920×1080 | 世界视图按容器取景，无拉伸或黑边 | 同上 | 同上 |
| 3840×2160 | 右侧视图保持比例；全景取景由现有世界控制提供 | 同上 | 同上 |

截图由 `e2e/desktop-preview.spec.ts` 自动生成。后续桌面阶段再处理签名更新、安装器现场验证、macOS/Linux、系统级快捷键和更细的退出任务清单。
