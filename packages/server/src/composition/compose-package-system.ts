import { join } from 'node:path'

import { LocalPackageCatalog, LocalPackageRuntime, PackageManager, type PackageRuntimePort } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { validateStagedPackageEntrypoints } from '../installed-package-runtime.js'

export interface PackageSystemCompositionInput {
  store: SqliteStore
  stateRoot: string
  marketplaceRoot: string
  additionalMarketplaceRoots?: string[]
  packageRuntime?: PackageRuntimePort
}

export async function composePackageSystem(input: PackageSystemCompositionInput) {
  const packageRuntime = input.packageRuntime ?? new LocalPackageRuntime(join(input.stateRoot, 'packages'))
  await packageRuntime.recover?.(
    input.store.listWorkspaces().flatMap((workspace) => input.store.listInstalledPackages(workspace.id)),
  )
  const packageManager = new PackageManager({
    store: input.store,
    runtime: packageRuntime,
    validateStaged: validateStagedPackageEntrypoints,
  })
  const packageCatalog = new LocalPackageCatalog(input.marketplaceRoot, {
    additionalRoots: input.additionalMarketplaceRoots ?? [],
  })
  return { packageManager, packageCatalog }
}
