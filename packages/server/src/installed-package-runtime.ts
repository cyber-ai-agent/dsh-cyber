import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { EmployeeBlueprint, InstalledPackage } from '@dsh-cyber/contracts'

const MAX_ENTRYPOINT_BYTES = 512 * 1024

interface PromptTransformDefinition {
  schemaVersion: 1
  commands: Array<{ trigger: string; instruction: string }>
}

export async function applyInstalledPromptTransforms(
  packages: InstalledPackage[],
  prompt: string,
): Promise<string> {
  let transformed = prompt
  for (const installed of packages.filter((item) => item.status === 'active')) {
    for (const entrypoint of installed.manifest.entrypoints ?? []) {
      if (entrypoint.kind !== 'prompt-transform') continue
      const definition = await readEntrypoint<PromptTransformDefinition>(installed, entrypoint.path)
      if (definition.schemaVersion !== 1 || !Array.isArray(definition.commands)) continue
      for (const command of definition.commands) {
        if (!validCommand(command) || !commandMatches(transformed, command.trigger)) continue
        transformed = `${command.instruction.trim()}\n\n用户原始请求：\n${transformed}`
      }
    }
  }
  return transformed
}

export async function loadInstalledBlueprints(packages: InstalledPackage[]): Promise<EmployeeBlueprint[]> {
  const blueprints: EmployeeBlueprint[] = []
  for (const installed of packages.filter((item) => item.status === 'active')) {
    for (const entrypoint of installed.manifest.entrypoints ?? []) {
      if (entrypoint.kind !== 'employee-blueprint') continue
      const value = await readEntrypoint<unknown>(installed, entrypoint.path)
      const candidates = Array.isArray(value) ? value : [value]
      for (const candidate of candidates) {
        const blueprint = parseBlueprint(candidate)
        if (blueprint !== undefined) blueprints.push(blueprint)
      }
    }
  }
  return blueprints
}

async function readEntrypoint<T>(installed: InstalledPackage, relativePath: string): Promise<T> {
  const path = join(installed.installedPath, ...relativePath.split('/'))
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_ENTRYPOINT_BYTES) {
    throw new Error(`Invalid installed package entrypoint: ${installed.packageId}/${relativePath}`)
  }
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function validCommand(value: unknown): value is { trigger: string; instruction: string } {
  if (typeof value !== 'object' || value === null) return false
  const command = value as Record<string, unknown>
  return typeof command.trigger === 'string' && command.trigger.trim().startsWith('/') &&
    typeof command.instruction === 'string' && command.instruction.trim().length > 0
}

function commandMatches(prompt: string, trigger: string): boolean {
  const normalized = trigger.trim()
  return prompt === normalized || prompt.startsWith(`${normalized} `) || prompt.startsWith(`${normalized}\n`)
}

function parseBlueprint(value: unknown): EmployeeBlueprint | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const strings = ['id', 'worldTemplateId', 'displayName', 'role', 'summary', 'persona', 'createdAt'] as const
  if (strings.some((field) => typeof input[field] !== 'string' || !(input[field] as string).trim())) return undefined
  if (typeof input.version !== 'number' || !Number.isInteger(input.version) || input.version < 1) return undefined
  if (!stringArray(input.requestedSkills) || !stringArray(input.requestedCapabilities)) return undefined
  return {
    id: input.id as string,
    version: input.version,
    worldTemplateId: input.worldTemplateId as string,
    displayName: input.displayName as string,
    role: input.role as string,
    summary: input.summary as string,
    persona: input.persona as string,
    requestedSkills: input.requestedSkills,
    requestedCapabilities: input.requestedCapabilities,
    createdAt: input.createdAt as string,
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0)
}
