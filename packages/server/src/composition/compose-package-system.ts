import { join } from 'node:path'

import { LocalPackageCatalog, LocalPackageRuntime, PackageManager, type PackageRuntimePort, type WorkspaceScopedCatalogRoots } from '@dsh-cyber/package-runtime'
import type { SqliteStore } from '@dsh-cyber/persistence'

import { validateStagedPackageEntrypoints } from '../installed-package-runtime.js'

export interface PackageSystemCompositionInput {
  store: SqliteStore
  stateRoot: string
  marketplaceRoot: string
  additionalMarketplaceRoots?: string[]
  /** Generated-package roots that belong to a single workspace. */
  workspaceMarketplaceRoots?: WorkspaceScopedCatalogRoots
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
    ...(input.workspaceMarketplaceRoots === undefined ? {} : { workspaceRoots: input.workspaceMarketplaceRoots }),
  })
  return { packageManager, packageCatalog }
}
