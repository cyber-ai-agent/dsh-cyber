# 社区共创规范

这里记录仓库当前可执行的扩展约定。它们由四类证据共同约束：contracts、严格解析器、运行时行为和自动化测试。

- [包生态与信任边界](package-ecosystem.md)
- [世界主题创作约定](world-theme-authoring.md)
- [皮肤包创作约定](skin-authoring.md)
- [员工蓝图创作约定](employee-blueprint-authoring.md)
- [声明式插件创作约定](plugin-authoring.md)
- [模型交互日志（运行时能力说明）](model-interaction-logs.md)
- [规范实现状态](implementation-status.md)

规范关键词含义：

- **MUST**：当前合同或贡献审核的硬性要求。
- **SHOULD**：强烈建议；偏离时必须在 PR 解释原因和替代验证。
- **ROADMAP**：尚未成为当前产品承诺，不能出现在“已支持”说明中。

这些文档不替代源码。涉及合同的 PR 必须同步修改相应 TypeScript 类型、解析器、测试和兼容性说明。
