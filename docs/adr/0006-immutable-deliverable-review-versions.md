# ADR 0006: Deliverable 与 Review 的不可变版本

- 状态：Accepted
- 日期：2026-08-27

## 背景

如果“要求修改”直接覆盖旧交付，系统无法证明用户审阅了哪个 Artifact、哪次 Run 产生了结果，也无法从 Review Feedback 建立可靠 Evidence 和 Growth 事实。

## 决策

Deliverable 必须引用不可变 `ArtifactVersion`，并使用单调递增版本。提交后的 Deliverable 内容不修改。Review 是追加事实，decision 为 `accept/request-changes/reject`。

`request-changes` 保留原 Deliverable 和 Review，Task 进入 changes-requested，创建新的 Plan Revision/TaskRun，把 Review Feedback 作为受信业务输入，最终生成新的 Deliverable version；旧版本在新版本提交后可标记 superseded，但不能删除。

被接受的 Deliverable 可以生成 GrowthEvidence；被拒绝的结果只能作为失败经历。模型自述不能直接提高熟练度。

## 结果

- Task、Run、ArtifactVersion、Deliverable、Review、Trace 和 Evidence 可双向追踪。
- 修改历史、验收责任和成长证据可审计。
- 重试/恢复可以通过 idempotencyKey 避免重复提交同一版本。

## 非目标

本 ADR 不定义在线多人协同编辑、Artifact 内容 diff 或完整技能等级算法。
