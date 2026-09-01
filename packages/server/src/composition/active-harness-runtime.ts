import {
  SUPPORTED_HARNESS_VERSION,
  inspectHarnessCandidate,
  readActiveHarnessRuntime,
  resolveCandidateDshBin,
} from '@dsh-cyber/harness-adapter'
import type { SqliteStore } from '@dsh-cyber/persistence'

/**
 * The compatibility matrix intentionally still lists older Harness releases,
 * so it cannot decide whether *this* build can drive an already-activated
 * runtime: the launch path only speaks the version this build pins. Validating
 * against the matrix therefore let an older activated runtime boot and fail on
 * the first turn as an unexplained model error.
 *
 * The activated runtime is checked against the pinned version instead, and a
 * mismatch fails the boot closed with the version and the recovery command
 * spelled out. That check does not read the matrix, so it behaves the same
 * before and after older entries are retired from it.
 */
export async function resolveActiveRuntime(
  store: SqliteStore,
  runtimeStateRoot: string,
  stateRoot: string,
): Promise<string | undefined> {
  const activeRuntime = await readActiveHarnessRuntime(runtimeStateRoot)
  if (activeRuntime === undefined) return undefined
  if (activeRuntime.version !== SUPPORTED_HARNESS_VERSION) {
    store.close()
    throw new Error(harnessVersionGateMessage(activeRuntime.version, stateRoot))
  }
  const activeReport = await inspectHarnessCandidate({
    candidateRoot: activeRuntime.candidateRoot,
    stateRoot: runtimeStateRoot,
  })
  // A pointer that claims the pinned version over an older tree on disk is the
  // same hazard, and the user needs the same instructions, not "incompatible".
  if (activeReport.version !== undefined && activeReport.version !== SUPPORTED_HARNESS_VERSION) {
    store.close()
    throw new Error(harnessVersionGateMessage(activeReport.version, stateRoot))
  }
  if (!activeReport.ok || activeReport.version !== activeRuntime.version) {
    store.close()
    throw new Error(
      `Activated Harness runtime is unavailable or incompatible. Run "dsh-cyber runtime-rollback --data-dir ${stateRoot}" to recover.`,
    )
  }
  return resolveCandidateDshBin(activeRuntime.candidateRoot)
}

function harnessVersionGateMessage(activeVersion: string, stateRoot: string): string {
  return [
    `已激活的 DeepSeek Harness 运行时是 ${activeVersion}，当前版本的 DSH Cyber 只能驱动 ${SUPPORTED_HARNESS_VERSION}，已停止启动，避免运行在无法驱动的运行时上。`,
    `升级方式一（推荐）：运行 "dsh-cyber runtime-rollback --data-dir ${stateRoot}" 恢复内置的 ${SUPPORTED_HARNESS_VERSION} 运行时；该命令会先创建完整的本地数据 Bundle，不会删除世界、创意工坊项目或聊天记录。`,
    `升级方式二：准备 ${SUPPORTED_HARNESS_VERSION} 的候选目录，先用 "dsh-cyber runtime-check --candidate-root <候选目录> --data-dir ${stateRoot}" 校验，再重新走验证、契约测试、金丝雀与激活流程。`,
  ].join('\n')
}
