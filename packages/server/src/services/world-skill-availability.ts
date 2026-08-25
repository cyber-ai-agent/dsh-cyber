/**
 * Host-provided World Skill Availability seam.
 *
 * The Skill Catalog is intentionally not owned by the route, persistence or
 * CharacterSkillRuntime packages.  They only need to ask one provider-neutral
 * question: can this skill be used by this world right now?  The application
 * composition root can later connect the real SkillCatalogService without
 * making these layers depend on its package/registry implementation.
 */
export interface WorldSkillAvailabilityInput {
  workspaceId: string
  worldId: string
  skillId: string
}

export interface WorldSkillAvailabilityPort {
  isAvailable(input: WorldSkillAvailabilityInput): boolean | Promise<boolean>
  /** Optional batch seam so catalog providers can scan a World once per turn. */
  availableSkillIds?(input: Omit<WorldSkillAvailabilityInput, 'skillId'> & { skillIds: readonly string[] }): readonly string[] | Promise<readonly string[]>
}

export async function unavailableWorldSkillIds(
  port: WorldSkillAvailabilityPort | undefined,
  input: Omit<WorldSkillAvailabilityInput, 'skillId'> & { skillIds: readonly string[] },
): Promise<string[]> {
  if (input.skillIds.length === 0) return []
  const available = new Set(await availableWorldSkillIds(port, input))
  return input.skillIds.filter((skillId) => !available.has(skillId))
}

export async function availableWorldSkillIds(
  port: WorldSkillAvailabilityPort | undefined,
  input: Omit<WorldSkillAvailabilityInput, 'skillId'> & { skillIds: readonly string[] },
): Promise<string[]> {
  if (input.skillIds.length === 0) return []
  if (port === undefined) return [...input.skillIds]
  if (port.availableSkillIds !== undefined) {
    const returned = new Set(await port.availableSkillIds(input))
    // A provider may return a cached/superset result; only preserve IDs the
    // caller asked about and retain the caller's deterministic ordering.
    return input.skillIds.filter((skillId) => returned.has(skillId))
  }
  const available: string[] = []
  for (const skillId of input.skillIds) if (await port.isAvailable({ ...input, skillId })) available.push(skillId)
  return available
}
