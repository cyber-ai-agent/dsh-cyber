# ADR 0007: 角色默认运行权限取代管理员角色

状态：Accepted

## 决策

产品层不再创建或展示“世界管理员”角色，不再提供管理员徽标、管理员概览或
`WorldPermissionEditor`。旧 `WorldCharacterAuthority` 表和服务仅作为开发期旧库
兼容读取边界保留，不参与新角色默认权限和 Harness 运行时解析。

每个 `EmployeeRevision` 保存一个 `runtimePermissionMode`：

- `read-only`：请求批准；读取当前世界目录。
- `workspace-write`：帮我批准；读写当前世界目录。
- `danger-full-access`：完全访问；使用当前系统账号可访问的路径。

新增角色必须选择默认档位。私聊默认使用角色档位；多人会话取参与角色中最
保守的档位。输入区仍可为当前消息选择更安全或不同的档位。

## 完全访问持久化

完全访问首次选择必须显式确认。确认后本地服务将 grant 绑定到
`(worldId, sessionId, employeeIds)` 并写入 SQLite
`owner_runtime_access_grants`。Web 在加载世界时恢复 grant 和选择器状态，因此
刷新、切换和服务重启后显示与真实授权一致。把角色改为较低档位时，相关 grant
立即删除。

角色、Skill、插件和 Prompt 均不能签发 grant；只有本机用户确认入口可以创建。

## 迁移

- schema 32：持久化 `owner_runtime_access_grants`。
- schema 33：`employee_revisions.runtime_permission_mode`，旧 revision 默认
  `read-only`。
- 新招募角色只创建兼容 `member` authority 空行，不创建管理员、不写管理员指针。

## 验证

- 服务重启后 grant 仍可授权同一世界、会话和角色。
- 新增角色选择的默认档位自动用于私聊。
- 多人会话取最低权限。
- 完全访问降级后 grant 被删除。
- 世界设置、角色设置、头像和会话中不出现管理员 UI。
