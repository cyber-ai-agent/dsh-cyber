import type {
  CharacterAvatarProfile,
  EmployeeBlueprint,
  EmployeeInstance,
  EmployeeProfile,
  InstalledPackage,
  JsonObject,
} from '@dsh-cyber/contracts'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { InstalledPackageVerificationCache } from '../installed-package-runtime.js'
import type { AssetService } from './asset-service.js'

const PREVIEW_MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
} as const satisfies Record<string, 'image/png' | 'image/jpeg' | 'image/webp'>

/**
 * Initial appearance for a character being recruited from a blueprint.
 *
 * The built-in avatar slot was decided once, when the talent was published.
 * Writing it into the first profile revision makes it durable, so the
 * conversation list, the 2D world and character management all read the same
 * answer instead of each deriving one that changes on the next reload.
 */
export function initialCharacterAppearance(blueprint: Pick<EmployeeBlueprint, 'fallbackAvatarIndex'>): JsonObject {
  const index = blueprint.fallbackAvatarIndex
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 7) return {}
  return { avatarIndex: index, worldSkinIndex: index }
}

export interface AdoptBlueprintAvatarInput {
  store: Pick<SqliteStore, 'getEmployeeProfile' | 'reviseEmployeeProfile'>
  assets: Pick<AssetService, 'uploadCharacterAvatar'>
  employee: EmployeeInstance
  blueprint: EmployeeBlueprint
  packages: readonly InstalledPackage[]
}

/**
 * Gives a freshly recruited character its own copy of the image the owner
 * uploaded when the talent was created.
 *
 * Without this the upload stays a marketplace preview: the card shows it and
 * the recruited character silently falls back to a built-in avatar. Copying
 * the bytes into a character-scoped asset also means the avatar survives the
 * talent package being uninstalled or replaced.
 *
 * Returns the new profile revision, or undefined when the blueprint carries
 * no owner-supplied image. A failure here is never fatal: the character keeps
 * the built-in avatar already seeded at recruit time.
 */
export async function adoptBlueprintAvatar(
  input: AdoptBlueprintAvatarInput,
): Promise<EmployeeProfile | undefined> {
  const previewPath = input.blueprint.avatarPreviewPath
  if (previewPath === undefined) return undefined
  const extension = previewPath.slice(previewPath.lastIndexOf('.') + 1)
  const mimeType = (PREVIEW_MIME_TYPES as Record<string, 'image/png' | 'image/jpeg' | 'image/webp'>)[extension]
  if (mimeType === undefined) return undefined

  const installed = input.packages.find((item) => item.packageId === input.blueprint.id && item.status === 'active')
  if (installed === undefined) return undefined

  // Package bytes are untrusted: this reads only a file the manifest declares
  // and re-checks its recorded digest before anything downstream sees it.
  const bytes = await new InstalledPackageVerificationCache().readFile(installed, previewPath)

  const uploaded = await input.assets.uploadCharacterAvatar({
    employeeId: input.employee.id,
    name: previewPath,
    mimeType,
    dataBase64: bytes.toString('base64'),
  })
  if (uploaded.avatarAsset.rendererKind !== 'image-2d') return undefined

  const descriptor: CharacterAvatarProfile = {
    schemaVersion: 1,
    identityId: input.employee.id,
    rendererKind: 'image-2d',
    assetId: uploaded.avatarAsset.assetId,
    portraitAssetId: uploaded.avatarAsset.assetId,
    sourceName: uploaded.avatarAsset.originalName,
    fallbackAvatarIndex: fallbackIndex(input.blueprint),
    capabilities: ['portrait'],
    publishedAt: new Date().toISOString(),
  }
  const current = input.store.getEmployeeProfile(input.employee.id)
  return input.store.reviseEmployeeProfile({
    employeeId: input.employee.id,
    appearance: {
      ...(current?.appearance ?? {}),
      ...initialCharacterAppearance(input.blueprint),
      digitalHumanAvatar: descriptor as unknown as JsonObject,
    },
    reason: `采用角色模板形象：${input.blueprint.displayName}`,
  })
}

function fallbackIndex(blueprint: Pick<EmployeeBlueprint, 'fallbackAvatarIndex'>): number {
  const appearance = initialCharacterAppearance(blueprint)
  return typeof appearance.avatarIndex === 'number' ? appearance.avatarIndex : 0
}
