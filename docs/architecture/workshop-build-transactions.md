# Creative Workshop Build Transactions

Creative Workshop 创建世界时会跨越多个持久化边界：生成包、Package Runtime、Blueprint、World、Character、世界本地目录和最终 `project.json`。因此构建流程不能把“删除临时项目目录”当成完整 rollback。

## 当前同步构建事务

```text
Normalize / validate all role definitions
        ↓
Compile all generated packages
        ↓
PackageManager.preview(all)
        ↓
installReversible(package 1..N)
        ↓
Save immutable Blueprints
        ↓
Create World + managed world root
        ↓
Recruit Characters + write embodiment/profile
        ↓
Persist project.json
        ↓
COMMIT
```

在 `project.json` 原子写入成功前，整个流程仍处于 Workshop 父事务内。

## Reversible Package Installation

普通市场安装继续调用：

```ts
PackageManager.install(input): Promise<InstalledPackage>
```

需要参与更大组合事务的调用方使用：

```ts
PackageManager.installReversible(input): Promise<ReversiblePackageInstallation>
```

返回的 handle 同时保留：

- 已安装 package；
- install transaction id；
- Package Runtime activation receipt。

父事务失败时只能把这个 opaque handle 交回：

```ts
PackageManager.compensate(handle, errorCode)
```

Workshop 不直接修改 `installed_packages`，也不自己猜 active pointer。

## Compensation Order

Workshop 发生晚期失败时执行：

```text
1. rollback World database entity
2. remove managed world root
3. discard generated Blueprints if no longer referenced
4. compensate activated packages in reverse order
5. remove unfinished Workshop project directory
```

Package compensation 本身执行：

```text
Package Runtime rollback(receipt)
        ↓
restore/remove active pointer + installed files
        ↓
Persistence compensation(transactionId)
        ↓
disable failed activated version
restore previous active version when present
mark transaction rolled-back
append audit event
```

运行时文件 rollback 放在数据库状态切换之前。这样如果文件系统补偿失败，数据库不会先谎称旧版本已经恢复。

## Audit Behavior

同步补偿会保留事务历史：

```text
package.install.approved
package.install.staged
package.install.activated
package.install.rolled-back
```

`package.install.rolled-back` 会记录 `compensatedAfterActivation: true`。

世界构建回滚会留下 workspace 级：

```text
world.creation.rolled-back
```

被回滚的世界自身 domain events 会随世界级数据一起清理，避免留下指向不存在世界的活动事实。

## What this solves

当前保证进程仍然存活时，以下错误不会留下半个可用世界：

- 第 N 个角色具身档案写入失败；
- 世界设置写入失败；
- 角色招聘后续步骤失败；
- 最终 Workshop project 持久化失败；
- 父级构建过程中其他同步异常。

测试必须验证：

- DB 中没有半成品 World；
- managed world root 被删除；
- generated Blueprint 不再被引用时删除；
- generated package 没有残留 active 状态；
- active pointer 恢复到旧版本或被删除；
- project source 不留下半成品；
- rollback audit 仍可追踪。

## Remaining crash-recovery boundary

当前实现解决**同步失败补偿**。如果宿主进程在多包已激活、`project.json` 尚未提交时直接崩溃或断电，内存中的 reversible handles 会丢失。

Creative Platform V1 稳定前的下一阶段应引入持久化 `WorkshopBuildTransaction`：

```text
prepared
→ packages-activated
→ world-created
→ characters-created
→ committed

or

→ compensating
→ rolled-back
```

启动时扫描未终结事务并进行恢复/补偿。这个能力会成为正式本地数据兼容基线之前的重要 release gate；当前 Pre-Alpha 不需要为了实验数据格式提前冻结 schema。
