# 包生态与信任边界

本约定描述 package schema v1 的当前实现，不描述尚未落地的远程市场。

## 当前支持范围

| 市场目录 | 市场分类 | 当前可运行包 kind / entrypoint |
| --- | --- | --- |
| `marketplace/themes` | `theme` | `world-theme` / `world-theme` |
| `marketplace/plugins` | `plugin` | `plugin` / `prompt-transform` |
| `marketplace/talent` | `talent` | `employee-blueprint` / `employee-blueprint` |

`talent` 是 UI/目录分类，不是包 kind。员工蓝图清单的 `kind` MUST 为 `employee-blueprint`。

当前市场是仓库内的本地只读目录。远程索引、发布者账号、付费、依赖解析、自动更新、卸载、签名验证和 `package pack|verify|publish` CLI 均为 ROADMAP。

## 包布局

每个包目录 MUST 包含 `dsh-cyber.package.json`，并包含 `files` 声明的全部文件。运行入口必须在 `entrypoints` 中声明，而且入口路径必须同时出现在 `files` 中。

清单的当前字段以 `CyberPackageManifest` 为准：

```json
{
  "schemaVersion": 1,
  "id": "community-package",
  "version": "1.0.0",
  "kind": "plugin",
  "displayName": "Community package",
  "summary": "A narrowly scoped package.",
  "license": "MIT",
  "publisher": "Contributor name",
  "capabilities": ["prompt:transform"],
  "dataEgress": [],
  "files": [
    { "path": "entrypoint.json", "sha256": "<64 lowercase hex>" }
  ],
  "entrypoints": [
    { "id": "main", "kind": "prompt-transform", "path": "entrypoint.json" }
  ]
}
```

作者 MUST：

- 使用合法 package id 和 SemVer；版本内容改变时发布新版本，不静默覆盖同一身份；
- 逐文件计算 SHA-256，禁止绝对路径、反斜杠、空段、`.`、`..` 和符号链接；
- 除 `dsh-cyber.package.json` 外，源目录中的每个普通文件都必须出现在 `files`，不得夹带未声明文件、隐藏条目或空壳之外的额外内容；
- 只声明实际需要的 `capabilities` 与 `dataEgress`，且数组内不重复；
- 确保入口 kind、包 kind 和所在市场一致；
- 为全部第三方内容提供许可证与来源证据。

严格 parser 会拒绝未知字段、重复项、超限集合、非法路径/SHA、非法 SemVer、控制字符和不符合 SPDX 表达式语法的 license，并强制入口与包类型、能力及外发边界一致。当前只做 SPDX 语法校验，不内置完整 SPDX 许可证注册表。

`prompt-transform` 必须属于 `plugin`，声明 `prompt:transform` 且 `dataEgress: []`；`employee-blueprint` 必须声明 `employee:blueprint`；`world-theme` 必须声明 `world:render`。后两类当前各只允许一个入口，避免现有选择 API 出现身份歧义。

## 发现、预览与安装

本地目录被扫描时会验证 manifest、源目录完整库存、逐文件哈希、普通文件类型和认证摘要。不合格目录不会进入市场列表。安装复制完成后还会在 staged 状态解析真实 entrypoint；入口 schema、蓝图身份/能力或主题资产不合格时，事务在 activate/persist 前回滚。

安装流程为：

```text
discover -> preview -> approve -> stage -> verify files -> activate -> persist
                                      \-> rollback on failure
```

预览生成的授权令牌具备以下约束：

- 使用加密随机数生成，只保存摘要；
- 默认五分钟过期；
- 只能消费一次，失败消费后也不能重放；
- 绑定 workspace、完整 manifest 内容和预览时的活动包身份；
- `files`、`entrypoints`、publisher、license、能力、外发或其他 manifest 内容变化都必须重新预览；
- 活动版本在 preview/install 之间变化时必须重新预览。

源目录本身不作为授权身份；安装阶段会按已批准 manifest 对每个源文件重新计算哈希，所以替换源内容会失败。

## 信任与认证

“被发现”“哈希一致”“已安装”“活动”和“官方认证”是不同状态。当前 `certification` 支持受信 authority、`official|community` level 和完整语义 manifest 摘要；摘要覆盖 publisher、license、能力、外发、入口和逐文件哈希，并排除摘要字段自身。它仍不是发布者私钥产生的密码学签名。

社区 PR SHOULD 省略 `certification`。贡献者不得自签 `official`，也不得把 `verified`、Ed25519/ECDSA 签名或恶意代码扫描写成当前已支持功能。

## 身份与不可变性

包身份是 `packageId + packageVersion`。世界主题还具有独立的主题身份：

```text
packageId + packageVersion + themeId + themeVersion + contentDigest
```

主题 id/version 不要求与包 id/version 相等。这样可以防止两个包声明相同主题 id/version 时同时被误判为同一个活动主题；渲染器 mount key 也必须包含不可冲突的包身份和内容摘要。

## PR 最低证据

市场包 PR MUST 包含：

- 完整目录和真实 SHA-256；
- 类型专项规范检查结果；
- 安装预览、安装成功及篡改拒绝证据；
- 许可证与资产来源；
- 对能力、数据外发和当前限制的明确说明。
