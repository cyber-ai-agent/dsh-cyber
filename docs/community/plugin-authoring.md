# 声明式插件创作约定

当前插件系统只支持声明式 `prompt-transform` 入口，不加载或执行第三方 JavaScript、TypeScript、原生模块、skill provider、tool provider、event subscriber 或 UI widget。

因此当前安全边界来自“没有执行第三方代码”，不是一个可承载任意插件代码的通用沙箱。

## 包和能力

插件清单 MUST 使用：

- `kind: "plugin"`；
- `entrypoints[].kind: "prompt-transform"`；
- `capabilities` 包含 `prompt:transform`；
- prompt-transform entrypoint 所属 package 必须是 `kind: "plugin"`，且 `dataEgress` 必须为空数组；
- entrypoint 和全部内容文件位于 manifest `files` 中。

当前 prompt transform 不发起网络请求；声明任何非空外发都会被 manifest parser 和运行时防御同时拒绝。未来只有在受控网络代理、权限与外发审计真实实现后，才可提案升级该边界。

## 当前入口 Schema（canonical）

entrypoint JSON 的当前格式是：

```json
{
  "schemaVersion": 1,
  "transforms": [
    {
      "id": "meeting-summary",
      "trigger": "/meeting-summary",
      "description": "整理当前会话中的会议事实。",
      "instruction": "只依据当前会话事实输出决策、负责人和截止日期。",
      "mode": "prepend",
      "priority": 100
    }
  ]
}
```

当前行为：

- `schemaVersion` MUST 为 `1`；
- `transforms` MUST 是包含 1 至 64 个对象的数组；每个 `id` MUST 唯一、匹配 `^[a-z0-9-]+$` 且不超过 64 个字符；
- `trigger` MUST 是 `always` 或小写 ASCII `/command`，命令只有在 prompt 等于 trigger，或以 `trigger + 空格/换行` 开头时才触发；`always` 对每条 prompt 触发；
- `description` MUST 是非空纯文本且不超过 200 个字符；`instruction` MUST 是非空纯文本且不超过 2000 个字符；入口中四类文本合计不超过 256 KiB；
- `mode` MUST 是 `prepend`、`append` 或 `replace`；`priority` 可省略（默认为 `0`），否则 MUST 是有限 safe integer；
- 所有命中的 transform 先按 `priority` 降序，再按 package id、版本、entrypoint id/path、transform id 和数组位置稳定排序；
- 最高优先级的 `replace`（如有）成为运行时 prompt 基础；否则基础是原始 prompt。`prepend` 按优先级降序置于基础之前，`append` 按优先级降序置于基础之后，各段以空行连接；
- 变换只影响发送给 Agent runtime 的 prompt。Conversation 会继续以用户原始消息写入 durable transcript；插件不得改写持久化消息。

旧版 `commands[{trigger,instruction}]` 仅作为明确的 legacy 兼容入口接受，并会转换成 `prepend`、priority `0` 的 canonical transform；官方 `official-meeting-notes` 已迁移到 canonical，新增包 MUST 使用 `transforms`。未知字段、重复 id、非法枚举/priority、控制字符和资源超限会拒绝入口，不会静默执行。

## 安全边界

插件作者不得宣称当前插件可以：

- 读取任意本地文件、跨会话历史或其他世界数据；
- 根据 `artifact:read` 自动读取文件；
- 访问外部 API 或获得外发审计日志；
- 注册工具、技能、事件监听器或 UI 组件；
- 修改系统消息或绕过 Agent/员工权限。

instruction 会进入真实 Agent 运行 prompt，因此仍应视为高影响内容。它 MUST 明确作用域，不能要求泄露秘密、覆盖系统约束、冒充其他员工或把推断当事实。

## 验证

以 `marketplace/plugins/official-meeting-notes` 为当前格式参考。插件 PR MUST 覆盖：命令精确匹配、`always`、空格/换行参数、普通消息不触发、三种 mode、优先级与多插件确定性、安装前权限展示、清单或入口篡改拒绝，以及真实 conversation route 中的 prompt 变换。

当前仓库没有 `dsh-cyber package pack|verify|test|publish` 或 publisher CLI，也没有插件监控页面和 `system.prompt.append` 审计事件。上述能力只能作为 ROADMAP 提案，不能写入当前使用说明。
