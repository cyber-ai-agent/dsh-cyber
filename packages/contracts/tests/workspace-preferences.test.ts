import { describe, expect, it } from 'vitest'

import {
  WORKSPACE_PREFERENCES_LIMITS,
  WorkspacePreferencesContractError,
  parseWorkspacePaneWidth,
} from '../src/index.js'

describe('workspace preference runtime schema', () => {
  it('accepts the shared integer boundaries and rejects drift outside them', () => {
    expect(parseWorkspacePaneWidth('leftPaneWidth', WORKSPACE_PREFERENCES_LIMITS.leftPaneWidth.minimum)).toBe(220)
    expect(parseWorkspacePaneWidth('leftPaneWidth', WORKSPACE_PREFERENCES_LIMITS.leftPaneWidth.maximum)).toBe(520)
    expect(parseWorkspacePaneWidth('rightPaneWidth', WORKSPACE_PREFERENCES_LIMITS.rightPaneWidth.minimum)).toBe(300)
    expect(parseWorkspacePaneWidth('rightPaneWidth', WORKSPACE_PREFERENCES_LIMITS.rightPaneWidth.maximum)).toBe(760)
    expect(() => parseWorkspacePaneWidth('leftPaneWidth', 219)).toThrow(WorkspacePreferencesContractError)
    expect(() => parseWorkspacePaneWidth('rightPaneWidth', 761)).toThrow('300 到 760')
    expect(() => parseWorkspacePaneWidth('rightPaneWidth', 500.5)).toThrow(WorkspacePreferencesContractError)
  })
})
