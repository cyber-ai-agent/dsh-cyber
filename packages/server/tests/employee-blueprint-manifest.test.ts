import { describe, expect, it } from 'vitest'

import { parseEmployeeBlueprintManifest } from '../src/employee-blueprint-manifest.js'

const valid = {
  schemaVersion: 1,
  id: 'community-architect',
  version: 1,
  worldTemplateId: 'cyber-company',
  displayName: '架构师',
  role: '软件架构师',
  summary: '负责可验证的系统边界。',
  persona: '你是独立架构师，只依据当前世界中已授权的证据工作。',
  requestedSkills: ['architecture-review'],
  requestedCapabilities: ['workspace:read'],
  createdAt: '2026-08-20T00:00:00.000Z',
}

const context = {
  packageId: valid.id,
  packageCapabilities: ['employee:blueprint', 'workspace:read'],
}

describe('employee blueprint manifest', () => {
  it('parses the versioned minimal blueprint contract', () => {
    expect(parseEmployeeBlueprintManifest(valid, context)).toEqual(valid)
  })

  it.each([
    ['unknown field', { ...valid, avatar: 'avatar.png' }, context],
    ['package identity mismatch', { ...valid, id: 'other' }, context],
    ['undeclared capability', { ...valid, requestedCapabilities: ['workspace:write'] }, context],
    ['duplicate skill', { ...valid, requestedSkills: ['architecture-review', 'architecture-review'] }, context],
    ['non-canonical time', { ...valid, createdAt: '2026-08-20' }, context],
    ['unsupported schema', { ...valid, schemaVersion: 2 }, context],
  ])('rejects %s', (_name, value, parseContext) => {
    expect(() => parseEmployeeBlueprintManifest(value, parseContext)).toThrow()
  })
})
