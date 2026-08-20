# 参与 DSH Cyber 共创

感谢你参与 DSH Cyber。仓库当前处于早期开发阶段；贡献应保持本地优先、可审计、最小权限和真实运行证据，不把路线图写成已经存在的能力。

本仓库采用 PolyForm Noncommercial License 1.0.0，可在 GitHub 公开共创，但不属于 OSI 认证的开源许可证。对外请使用“社区共创”或“source-available contribution”，不要误称为 OSI open source。

## 事实来源

当文档、示例和实现不一致时，不允许只选择其中一份作为结论。PR 必须同时核对：

1. `packages/contracts/src` 中的公开类型与版本，确定可表达的合同边界；
2. 对应解析器、服务和持久化实现，确定真实接受条件和领域行为；
3. 自动化测试与 `.github/workflows/ci.yml`，确认正反场景有持续证据；
4. `docs/community` 中的创作约定，确认贡献者能准确复现当前规则；
5. issue、讨论稿和路线图，区分已实现要求与未来提案。

如果实现具有更完整且经过测试的安全边界，文档和示例 MUST 随 PR 更新；如果规范提出的边界更完整，PR MUST 把它落实到真实解析、运行、持久化或交互链路并补测试，不能只改文档。无法在当前架构安全落地的提案必须明确保留为 ROADMAP，并解释由哪个现有边界替代。

讨论稿不能单独改变 HTTP API、SQLite schema、包 schema 或 World Runtime contract。任何合同变更必须同时修改类型、解析器、迁移策略、兼容性说明和测试。

## 开发流程

1. 从最新 `main` 创建范围明确的分支，例如 `fix/...`、`feat/...`、`refactor/...` 或 `docs/...`。
2. 提交前先说明问题、验收条件和不在范围内的内容；大型合同变更先提交 issue 或 ADR。
3. 保持提交可审查，不混入本地数据、生成截图、日志、数据库或无关格式化。
4. Pull Request 使用仓库模板，列出真实测试结果和仍未验证的内容。
5. CI 必须通过后才合并；不得删除断言、跳过失败场景或把路线图描述为完成来绕过门禁。

本地基础门禁：

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm verify
```

Node.js 与 pnpm 版本以根目录 `package.json` 和 CI 工作流为准。影响浏览器交互、世界渲染或恢复流程的变更，还应附实际浏览器尺寸、控制台检查和截图路径。

## 市场包贡献

市场包必须先阅读 [包生态与信任边界](docs/community/package-ecosystem.md)，再按类型阅读：

- [世界主题创作约定](docs/community/world-theme-authoring.md)
- [员工蓝图创作约定](docs/community/employee-blueprint-authoring.md)
- [声明式插件创作约定](docs/community/plugin-authoring.md)

贡献者必须声明完整文件清单、逐文件 SHA-256、许可证、发布者、能力和数据外发。社区贡献不得自行标记为 `official`；认证字段由维护者在独立审核后决定。安装授权令牌是运行时临时凭据，绝不能写入包、测试夹具或 Git 历史。

## 安全与隐私

- 不提交 `.env`、密钥、Cookie、私有会话、数据库、`.local-data`、`.private`、运行日志或用户工作区内容。
- 不用符号链接、绝对路径、`..`、外部 CDN 或隐藏文件绕过包边界。
- 不扩大 `capabilities` 或 `dataEgress` 以“备用”；只声明真实需要的最小集合。
- 发现漏洞时不要在公开 issue 中附利用细节、凭据或真实用户数据，应先联系维护者进行私下披露。

## 许可证与署名

提交贡献即表示你有权提交相关代码、文档和资产，并同意贡献按仓库 [LICENSE](LICENSE) 分发。第三方资产必须提供可核验来源和兼容许可证；不得提交来源不明、不可再分发或仅允许个人使用的内容。
