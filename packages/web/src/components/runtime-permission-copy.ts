import type { AgentPermissionMode } from '@dsh-cyber/contracts'

/** Shared scope descriptions for the conversation and character settings. */
export function runtimePermissionCopy(t: (key: string, fallback: string) => string, mode: AgentPermissionMode) {
  if (mode === 'danger-full-access') return {
    label: t('workbench.permissionFullAccess', '完全访问'),
    description: t('workbench.permissionFullAccessDesc', '可读写当前系统账号可访问的文件并执行命令，不再请求工具审批。'),
  }
  if (mode === 'workspace-write') return {
    label: t('workbench.permissionWorkspaceWrite', '当前世界'),
    description: t('workbench.permissionWorkspaceWriteDesc', '可读写当前世界的项目目录；越界操作需单独批准。'),
  }
  return {
    label: t('workbench.permissionReadOnly', '只读访问'),
    description: t('workbench.permissionReadOnlyDesc', '允许读取与搜索；修改文件需单独批准。'),
  }
}
