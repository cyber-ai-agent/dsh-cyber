export const WORKSPACE_PREFERENCES_LIMITS = Object.freeze({
  backgroundOpacity: Object.freeze({ minimum: 0, maximum: 1 }),
  leftPaneWidth: Object.freeze({ minimum: 220, maximum: 520 }),
  rightPaneWidth: Object.freeze({ minimum: 300, maximum: 760 }),
})

export type WorkspacePaneWidthKey = 'leftPaneWidth' | 'rightPaneWidth'

export class WorkspacePreferencesContractError extends Error {
  readonly code = 'workspace_preferences_out_of_range'

  constructor(readonly field: WorkspacePaneWidthKey, readonly value: unknown) {
    const limit = WORKSPACE_PREFERENCES_LIMITS[field]
    super(`${field} 必须是 ${limit.minimum} 到 ${limit.maximum} 之间的整数像素值`)
    this.name = 'WorkspacePreferencesContractError'
  }
}

/** Shared runtime schema for every persisted pane width boundary. */
export function parseWorkspacePaneWidth(field: WorkspacePaneWidthKey, value: unknown): number {
  const limit = WORKSPACE_PREFERENCES_LIMITS[field]
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < limit.minimum
    || value > limit.maximum
  ) throw new WorkspacePreferencesContractError(field, value)
  return value
}
