# Skill Catalog 与角色学习 V2

## 目标

角色招募和已有角色能力编辑都使用当前世界的 Skill Catalog。目录是只读、按世界计算的发现投影；它不改变 Blueprint、Skill Grant 或 Runtime 的权威边界。

```text
GET /api/catalog/blueprints?worldId=:worldId
GET /api/worlds/:worldId/skill-catalog
        │
        ├─ 推荐技能：蓝图 requestedSkills ∩ 当前世界可用目录
        ├─ 其他可学习技能：worldAvailable + availability=available
        └─ 当前不可用：角色已有但当前 World unavailable 或目录缺失的历史 grant
```

接口响应统一为 `{ items: SkillCatalogEntry[] }`。前端只做容错解析，不复制一套本地权限词汇；`worldAvailable` 与 `availability` 决定当前世界是否可学习。

## 角色学习语义

- 招募时只从 Blueprint 的 `requestedSkills` 产生推荐选择；其中当前 World 可用的项默认勾选。目录中的 `recommendedByDefault` 不能把未被 Blueprint 请求的 Skill 偷渡进招募。
- 用户显式取消默认项后，空选择仍然是有效选择，不会因为目录加载或其他表单更新被重新勾选。
- 已有角色可以勾选目录中的非 Blueprint Skill，保存仍通过现有 `EmployeeRevision.skillGrants` 修订流程完成。
- 历史 grant 如果在当前 World unavailable 或目录缺失，仍显示在“当前不可用”，可以保留，也可以取消勾选撤销；未 grant 的不可用目录项不进入角色编辑器，也不能被 UI 静默扩展成授权。
- Skill Grant 只表示角色获得某个 Character Skill；它不等于世界权限、底层 Capability、文件沙箱或动作审批。

## 边界：Plugin Command != Character Skill

Plugin Command 是声明式 prompt-transform 或聊天入口：它可以改变输入组合或把用户意图带入当前聊天，但不会因此授予角色 Skill，也不会绕过 Skill Grant、World Permission 或 Approval Gate。

Character Skill 是由受信任 Host Adapter 提供、可被角色授权并在具体动作边界重新检查的能力。插件可以声明或安装相关资源，但“已安装插件”“可见命令”都不能推导出 Character Skill Grant。只有显式的角色修订或招募选择，才会产生角色 Skill grant。

## 前端投影

`SkillGrantEditor` 使用 `employee.worldId` 请求两个 world-scoped catalog，按“推荐技能 / 其他可学习技能 / 当前不可用”单列分组，并显示“推荐 / 已启用 / 可学习 / 暂不可用”。`RecruitmentDialog` 使用同一世界目录，并把默认推荐与显式空选择区分开。

前端不在 catalog 请求中使用 workspace 作为世界能力的替代范围，也不把 unavailable 历史 grant 当作可执行能力。目录读取失败时保留可诊断错误，保存仍由既有 revision API 负责最终校验。

## 验收

- Web component tests 覆盖 world-scoped 请求、非 Blueprint Skill 勾选、历史 unavailable grant 保留/撤销、推荐默认和显式空选择。
- Chromium targeted E2E 使用真实 marketplace preview/install、World Package Instance、Catalog API、revision POST、刷新持久化和 HTTP chat，验证 World A 可用、World B unavailable、审批前 SkillAction 不执行；三视口截图与 console 日志写入 `artifacts/skill-catalog-character-learning/`。
- Catalog Service 负责发现与 World availability，employee revision 与 Character Skill Runtime 负责最终 gate；前端只投影结果，不替代 Server、Persistence、Contracts 和 Runtime 的权威边界。
