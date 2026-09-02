import type { CyberSkinManifestV1 } from '@dsh-cyber/contracts'
import { BUILTIN_THEMES, themeRegistry, type WorldThemeConfig, type WorldThemeTokens } from './world-themes.js'

/** One installed skin package's declaration, as `GET /api/workspaces/:id/skins` lists it. */
export interface InstalledSkinDeclaration {
  packageId: string
  packageVersion: string
  entrypointId: string
  entrypointPath: string
  manifest: CyberSkinManifestV1
}

/** Same literal the server's skin schema accepts: one lowercase `#rrggbb`. */
const HEX_COLOR = /^#[0-9a-f]{6}$/u

/**
 * Register every installed skin that declares a palette as a package theme,
 * and drop the package themes whose skin is no longer installed.
 *
 * The declaration is the only input: the host builds the tokens from six hex
 * colours and one opacity, and resolves an optional backdrop by looking up an
 * official built-in skin by id. A package never names an asset path, a
 * stylesheet or a built-in theme id it could shadow.
 */
export function syncInstalledSkinThemes(items: readonly InstalledSkinDeclaration[]): void {
  const declared = new Set<string>()
  for (const item of items) {
    const theme = packageTheme(item)
    if (theme === undefined) continue
    themeRegistry.registerPackageTheme(theme)
    declared.add(theme.id)
  }
  for (const theme of themeRegistry.list()) {
    if (theme.source === 'package' && !declared.has(theme.id)) themeRegistry.unregisterPackageTheme(theme.id)
  }
}

function packageTheme(item: InstalledSkinDeclaration): WorldThemeConfig | undefined {
  const manifest = item.manifest
  const palette = manifest.palette
  if (palette === undefined) return undefined
  // Built-in ids are host-owned; a package may bind one but never redefine it.
  if (BUILTIN_THEMES.some((builtin) => builtin.id === manifest.themeId)) return undefined
  const colors = [palette.accentColor, palette.pageBackground, palette.panelBackground, palette.textColor, palette.ownerBubbleColor, palette.characterBubbleColor]
  if (!colors.every((color) => typeof color === 'string' && HEX_COLOR.test(color))) return undefined
  const opacity = typeof palette.backdropOpacity === 'number' && palette.backdropOpacity >= 0.2 && palette.backdropOpacity <= 1 ? palette.backdropOpacity : undefined
  const backdrop = manifest.backdropSkinId === undefined ? undefined : BUILTIN_THEMES.find((builtin) => builtin.id === manifest.backdropSkinId)
  const backdropImage = backdrop?.tokens.backdropImage ?? backdrop?.tokens.worldMapImage
  const tokens: WorldThemeTokens = {
    accentColor: palette.accentColor,
    pageBackground: palette.pageBackground,
    panelBackground: palette.panelBackground,
    textColor: palette.textColor,
    ownerBubbleColor: palette.ownerBubbleColor,
    characterBubbleColor: palette.characterBubbleColor,
    ...(backdropImage === undefined ? {} : { backdropImage, ...(opacity === undefined ? {} : { backdropOpacity: opacity }) }),
  }
  return {
    id: manifest.themeId,
    displayName: manifest.displayName,
    description: manifest.summary,
    author: '皮肤包',
    source: 'package',
    packageId: item.packageId,
    version: item.packageVersion,
    tokens,
  }
}
