## 变更说明

<!-- 说明问题、验收条件和明确不在范围内的内容。 -->

## 验证证据

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:e2e`（不适用时说明原因）
- [ ] `pnpm verify`
- [ ] 没有通过删除断言、跳过测试或隐藏错误规避失败
- [ ] 浏览器/渲染改动已附尺寸、控制台结果和截图路径

## 合同与兼容性

- [ ] 未改变 HTTP method/path/body/response/status/SSE；如有改变，已明确版本和迁移方案
- [ ] 未静默改变 SQLite schema、package schema 或 World Runtime contract
- [ ] 文档只描述已实现能力，ROADMAP 已明确标注

## 市场包（不适用可删除）

- [ ] 已阅读 `docs/community` 对应创作约定
- [ ] `files` 覆盖全部内容且 SHA-256 为真实值
- [ ] entrypoint、package kind 与市场目录一致
- [ ] capabilities/dataEgress 最小且与真实行为一致
- [ ] 无绝对路径、遍历、符号链接、外部主题资产或隐藏敏感文件
- [ ] 已提供许可证和第三方资产来源
- [ ] 未自行标记 `official` 或提交 approval token
- [ ] 已验证安装、篡改拒绝、失败回滚和重启恢复（适用时）

## 风险与限制

<!-- 列出仍未验证的环境、已知限制和回滚方式。 -->
