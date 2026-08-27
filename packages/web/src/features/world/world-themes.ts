import type { World, WorldThemeManifestV1 } from '@dsh-cyber/contracts'
import { worldExperience } from '../../world-experience.js'
import { cyberCompanyTheme, maidPalaceTheme, moonlitTavernTheme } from '@dsh-cyber/world-runtime'

export const WORLD_THEME_STORAGE_PREFIX = 'dsh_world_theme:'
export const CUSTOM_THEMES_STORAGE_KEY = 'dsh_custom_themes'
export const DEFAULT_SKIN_ID = 'default'

/**
 * 标准世界主题令牌集 (Token Spec)
 * 解耦硬编码 CSS，所有视觉效果均由此纯数据驱动
 */
export interface WorldThemeTokens {
  accentColor: string
  accentSoft?: string
  accentStrong?: string
  pageBackground: string
  panelBackground: string
  panelBorder?: string
  textColor?: string
  mutedTextColor?: string
  ownerBubbleColor: string
  characterBubbleColor: string
  backdropImage?: string
  backdropOpacity?: number
  characterLeftImage?: string
  characterRightImage?: string
  worldMapImage?: string
}

/**
 * 标准世界主题定义 (Theme Definition)
 * 支持内置、用户自定义以及未来扩展包/插件安装
 */
export interface WorldThemeConfig {
  id: string
  displayName: string
  description: string
  author: string
  source: 'builtin' | 'custom' | 'package'
  packageId?: string
  version?: string
  tokens: WorldThemeTokens
  runtimeManifest?: WorldThemeManifestV1
}

export const orcaLinkManifest: WorldThemeManifestV1 = {
  schemaVersion: 1,
  id: 'dsh-cyber.orca.vessel',
  version: '1.0.0',
  templateId: 'orca-link',
  displayName: '虎鲸链路 · 深海舰桥',
  renderer: 'pixi-2d',
  terminology: {
    world: '航行舱',
    participant: '船员',
    session: '舰桥通信',
    milestone: '航海日志',
  },
  assets: [
    {
      id: 'orca-scene',
      src: '/assets/skins/orca-bridge-night.png',
      kind: 'image',
      preload: true,
      pixelArt: false,
    },
    cyberCompanyTheme.assets[1]!,
  ],
  actorSets: cyberCompanyTheme.actorSets,
  scenes: [
    {
      id: 'orca-bridge',
      displayName: '虎鲸舰桥甲板',
      size: { width: 1792, height: 1120 },
      cameraBounds: { x: 0, y: 0, width: 1792, height: 1120 },
      safeArea: { x: 40, y: 40, width: 1712, height: 1040 },
      layers: [
        {
          id: 'vessel-interior',
          assetId: 'orca-scene',
          destination: { x: 0, y: 0, width: 1792, height: 1120 },
          zIndex: 0,
        },
      ],
      anchors: [
        { id: 'spawn', position: { x: 836, y: 800 }, facing: 'north', capacity: 8, tags: ['spawn'] },
        { id: 'bridge', position: { x: 836, y: 480 }, facing: 'north', capacity: 3, tags: ['work', 'talk'] },
        { id: 'nav-deck', position: { x: 400, y: 520 }, facing: 'east', capacity: 2, tags: ['work', 'inspect'] },
        { id: 'comms', position: { x: 1250, y: 520 }, facing: 'west', capacity: 2, tags: ['idle', 'talk'] },
        { id: 'meeting-bridge', position: { x: 836, y: 640 }, facing: 'south', capacity: 4, tags: ['meeting'] },
      ],
      navigation: {
        origin: { x: 0, y: 0 },
        cellSize: 64,
        columns: 26,
        rows: 15,
        blocked: [],
      },
      interactables: [
        {
          id: 'vessel-bridge',
          kind: 'meeting-table',
          displayName: '舰桥指挥席',
          bounds: { x: 600, y: 400, width: 480, height: 300 },
          approachAnchorIds: ['meeting-bridge'],
          actions: [{ id: 'start-meeting', label: '发起全舰广播与会议' }],
          zIndex: 160,
        },
        {
          id: 'vessel-comms',
          kind: 'notice-board',
          displayName: '战舰通信终端',
          bounds: { x: 1180, y: 440, width: 220, height: 260 },
          approachAnchorIds: ['comms'],
          actions: [{ id: 'assign-task', label: '下达航行指令' }],
          zIndex: 150,
        },
      ],
      growthSlots: [
        { id: 'vessel-skill', category: 'skill', position: { x: 1200, y: 350 }, zIndex: 130 },
      ],
    },
  ],
  activityMapping: cyberCompanyTheme.activityMapping,
}

/**
 * 系统官方内置主题 (Built-in Themes)
 */
export const BUILTIN_THEMES: WorldThemeConfig[] = [
  {
    id: DEFAULT_SKIN_ID,
    displayName: '默认皮肤',
    description: 'DSH Cyber 原生深色工作台，保持清晰克制的默认阅读体验',
    author: '官方内置',
    source: 'builtin',
    tokens: {
      accentColor: '#e6b940',
      accentSoft: 'rgba(230, 185, 64, 0.16)',
      accentStrong: '#f4d36e',
      pageBackground: '#080d12',
      panelBackground: 'rgba(10, 17, 24, 0.95)',
      panelBorder: 'rgba(230, 185, 64, 0.32)',
      textColor: '#edf2f7',
      mutedTextColor: '#9eabb8',
      ownerBubbleColor: '#263629',
      characterBubbleColor: '#141c22',
      backdropImage: '/assets/cyber-office-world-clean.png',
      backdropOpacity: 0.9,
      worldMapImage: '/assets/cyber-office-world-clean.png',
    },
  },
  {
    id: 'maid-atelier',
    displayName: '深海女仆工坊',
    description: '深海宫殿 · 蓝金微晶 · 双女仆立绘与月光大厅',
    author: '官方内置',
    source: 'builtin',
    tokens: {
      accentColor: '#38bdf8',
      accentSoft: 'rgba(56, 189, 248, 0.16)',
      accentStrong: '#7dd3fc',
      pageBackground: '#070e17',
      panelBackground: 'rgba(8, 18, 48, 0.94)',
      panelBorder: 'rgba(197, 164, 104, 0.45)',
      textColor: '#f8f6f0',
      mutedTextColor: '#c5a468',
      ownerBubbleColor: '#122648',
      characterBubbleColor: '#0a1630',
      // The chat surface and the World dock are two views into the same
      // palace scene. Keep the backdrop and the runtime map on one source so
      // a pane resize or theme switch never presents unrelated rooms.
      backdropImage: '/assets/skins/maid-palace-night.webp',
      backdropOpacity: 0.95,
      characterLeftImage: '/assets/skins/maid-left.webp',
      characterRightImage: '/assets/skins/maid-right.webp',
      worldMapImage: '/assets/skins/maid-palace-night.webp',
    },
    runtimeManifest: maidPalaceTheme,
  },
  {
    id: 'cyber-company',
    displayName: '赛博原厂',
    description: '赛博办公室 · 黑曜高光 · 极简冷冽全息科技感',
    author: '官方内置',
    source: 'builtin',
    tokens: {
      accentColor: '#00e5ff',
      accentSoft: 'rgba(0, 229, 255, 0.16)',
      accentStrong: '#38bdf8',
      pageBackground: '#060a10',
      panelBackground: 'rgba(9, 15, 24, 0.94)',
      panelBorder: 'rgba(0, 229, 255, 0.35)',
      textColor: '#f1f5f9',
      mutedTextColor: '#00e5ff',
      ownerBubbleColor: '#0c2233',
      characterBubbleColor: '#08131d',
      backdropImage: '/assets/cyber-office-world.png',
      backdropOpacity: 0.92,
      worldMapImage: '/assets/cyber-office-world.png',
    },
    runtimeManifest: cyberCompanyTheme,
  },

  {
    id: 'orca-link',
    displayName: '虎鲸链路',
    description: '深海舰桥 · 深蓝电光 · 虎鲸导航全景',
    author: '官方内置',
    source: 'builtin',
    tokens: {
      accentColor: '#38bdf8',
      accentSoft: 'rgba(56, 189, 248, 0.16)',
      accentStrong: '#7dd3fc',
      pageBackground: '#070f1a',
      panelBackground: 'rgba(8, 19, 36, 0.94)',
      panelBorder: 'rgba(56, 189, 248, 0.4)',
      textColor: '#f0f9ff',
      mutedTextColor: '#38bdf8',
      ownerBubbleColor: '#0c2e4e',
      characterBubbleColor: '#081a2e',
      backdropImage: '/assets/skins/orca-bridge-night.png',
      backdropOpacity: 0.92,
      worldMapImage: '/assets/skins/orca-bridge-night.png',
    },
    runtimeManifest: orcaLinkManifest,
  },
  {
    id: 'moonlit-tavern',
    displayName: '月影酒馆',
    description: '中世纪古典奇幻沙龙 · 暖灰琥珀 · 木质壁炉暖色调',
    author: '官方内置',
    source: 'builtin',
    tokens: {
      accentColor: '#f59e0b',
      accentSoft: 'rgba(245, 158, 11, 0.16)',
      accentStrong: '#fbbf24',
      pageBackground: '#110c06',
      panelBackground: 'rgba(26, 18, 10, 0.94)',
      panelBorder: 'rgba(245, 158, 11, 0.42)',
      textColor: '#fffbeb',
      mutedTextColor: '#f59e0b',
      ownerBubbleColor: '#33210d',
      characterBubbleColor: '#1d1308',
      backdropImage: '/assets/moonlit-tavern-world.png',
      backdropOpacity: 0.92,
      worldMapImage: '/assets/moonlit-tavern-world.png',
    },
    runtimeManifest: moonlitTavernTheme,
  },
]

/**
 * 主题注册中心 (Theme Registry)
 * 统一管理内置、自定义与扩展包主题，提供动态注册、编辑与查询
 */
class WorldThemeRegistry {
  private customThemes: Map<string, WorldThemeConfig> = new Map()
  private packageThemes: Map<string, WorldThemeConfig> = new Map()

  constructor() {
    this.loadCustomThemesFromStorage()
  }

  private loadCustomThemesFromStorage() {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as WorldThemeConfig[]
      if (Array.isArray(parsed)) {
        parsed.forEach((theme) => {
          if (theme && theme.id) this.customThemes.set(theme.id, theme)
        })
      }
    } catch (e) {
      console.warn('Failed to load custom themes from storage', e)
    }
  }

  private persistCustomThemes() {
    if (typeof window === 'undefined') return
    try {
      const list = Array.from(this.customThemes.values())
      window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(list))
    } catch (e) {
      console.warn('Failed to persist custom themes', e)
    }
  }

  /**
   * 获取所有可用主题列表（内置 + 用户自定义 + 扩展包）
   */
  public list(): WorldThemeConfig[] {
    return [
      ...BUILTIN_THEMES,
      ...Array.from(this.customThemes.values()),
      ...Array.from(this.packageThemes.values()),
    ]
  }

  /**
   * Return only skins that may be selected in the world switcher.
   *
   * The default skin and user-created skins are always available. Built-in
   * visual skins become selectable only after their matching skin package is
   * installed in the local package library.
   */
  public listAvailable(installedSkinIds?: Iterable<string>): WorldThemeConfig[] {
    if (installedSkinIds === undefined) return this.list()
    const installed = new Set(installedSkinIds)
    return this.list().filter((theme) => {
      if (theme.id === DEFAULT_SKIN_ID || theme.source === 'custom') return true
      const packageId = theme.packageId ?? theme.id
      return installed.has(theme.id) || installed.has(packageId)
    })
  }

  /**
   * 根据 ID 检索主题，未找到时安全回退
   */
  public get(id: string): WorldThemeConfig {
    const found =
      this.customThemes.get(id) ??
      this.packageThemes.get(id) ??
      BUILTIN_THEMES.find((t) => t.id === id)

    if (found) return found
    return BUILTIN_THEMES.find((theme) => theme.id === DEFAULT_SKIN_ID) ?? BUILTIN_THEMES[0]!
  }

  /**
   * 注册或更新用户自定义主题
   */
  public saveCustomTheme(theme: WorldThemeConfig): void {
    const customized: WorldThemeConfig = {
      ...theme,
      source: 'custom',
      author: theme.author || '用户自定义',
    }
    this.customThemes.set(customized.id, customized)
    this.persistCustomThemes()
  }

  /**
   * 删除用户自定义主题
   */
  public deleteCustomTheme(id: string): boolean {
    const deleted = this.customThemes.delete(id)
    if (deleted) this.persistCustomThemes()
    return deleted
  }

  /**
   * 注册来自扩展包/插件的主题
   */
  public registerPackageTheme(theme: WorldThemeConfig): void {
    this.packageThemes.set(theme.id, {
      ...theme,
      source: 'package',
    })
  }

  /**
   * 卸载扩展包主题
   */
  public unregisterPackageTheme(id: string): void {
    this.packageThemes.delete(id)
  }
}

export const themeRegistry = new WorldThemeRegistry()

/**
 * 读取特定世界绑定的主题 ID
 */
export function readWorldTheme(world: World): string {
  if (typeof window === 'undefined') return DEFAULT_SKIN_ID
  const saved = window.localStorage.getItem(`${WORLD_THEME_STORAGE_PREFIX}${world.id}`)
  if (saved) return saved
  return DEFAULT_SKIN_ID
}

/**
 * 保存世界与主题的绑定关系并立即应用
 */
export function saveWorldTheme(worldId: string, themeId: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(`${WORLD_THEME_STORAGE_PREFIX}${worldId}`, themeId)
  applyWorldTheme(themeId)
}

/**
 * 统一令牌应用器 (Token Injector)
 * 将主题纯数据动态注入为标准 CSS 变量，彻底消除硬编码 class 分支
 */
export function applyWorldTheme(themeId: string): void {
  if (typeof document === 'undefined') return
  const theme = themeRegistry.get(themeId)
  const root = document.documentElement
  const tokens = theme.tokens

  // 1. 核心色彩令牌
  root.style.setProperty('--theme-accent', tokens.accentColor)
  root.style.setProperty('--theme-accent-soft', tokens.accentSoft ?? `color-mix(in srgb, ${tokens.accentColor} 18%, transparent)`)
  root.style.setProperty('--theme-accent-strong', tokens.accentStrong ?? tokens.accentColor)
  root.style.setProperty('--theme-bg', tokens.pageBackground)
  root.style.setProperty('--theme-panel', tokens.panelBackground)
  root.style.setProperty('--theme-panel-border', tokens.panelBorder ?? `color-mix(in srgb, ${tokens.accentColor} 30%, transparent)`)
  root.style.setProperty('--theme-text', tokens.textColor ?? '#f8f6f0')
  root.style.setProperty('--theme-muted', tokens.mutedTextColor ?? 'color-mix(in srgb, var(--theme-text) 60%, transparent)')

  // 2. 聊天气泡令牌
  root.style.setProperty('--theme-owner-bubble', tokens.ownerBubbleColor)
  root.style.setProperty('--theme-character-bubble', tokens.characterBubbleColor)

  // 3. 背景全景与立绘
  // A theme's runtime map is the canonical scene. When both panes are
  // visible, the conversation backdrop must be a view of that same scene,
  // otherwise the center and the World dock read as unrelated rooms.
  const sceneImage = tokens.worldMapImage ?? tokens.backdropImage
  if (sceneImage) {
    root.style.setProperty('--theme-backdrop-image', `url('${sceneImage}')`)
    root.style.setProperty('--skin-backdrop', `url('${sceneImage}')`)
    root.style.setProperty('--theme-backdrop-opacity', String(tokens.backdropOpacity ?? 0.95))
  } else {
    root.style.removeProperty('--theme-backdrop-image')
    root.style.removeProperty('--skin-backdrop')
    root.style.removeProperty('--theme-backdrop-opacity')
  }

  if (tokens.characterLeftImage) {
    root.style.setProperty('--theme-character-left', `url('${tokens.characterLeftImage}')`)
    root.style.setProperty('--skin-character-left', `url('${tokens.characterLeftImage}')`)
  } else {
    root.style.setProperty('--theme-character-left', 'none')
    root.style.setProperty('--skin-character-left', 'none')
  }

  if (tokens.characterRightImage) {
    root.style.setProperty('--theme-character-right', `url('${tokens.characterRightImage}')`)
    root.style.setProperty('--skin-character-right', `url('${tokens.characterRightImage}')`)
  } else {
    root.style.setProperty('--theme-character-right', 'none')
    root.style.setProperty('--skin-character-right', 'none')
  }

  // 4. 世界地图底图
  if (tokens.worldMapImage) {
    root.style.setProperty('--theme-world-map', `url('${tokens.worldMapImage}')`)
  } else {
    root.style.removeProperty('--theme-world-map')
  }

  // 保留 dataset.skin 作为向下兼容与特定微调挂钩
  root.dataset.skin = theme.id
}

/**
 * 动态解析或生成世界的 2.5D 运行时场景清单 (WorldThemeManifestV1)
 * 完全由主题的纯数据驱动，无需硬编码 if 分支
 */
export function resolveThemeManifest(world: World, themeId: string, baseManifest?: WorldThemeManifestV1): WorldThemeManifestV1 {
  const theme = themeRegistry.get(themeId)
  if (theme.runtimeManifest) {
    return theme.runtimeManifest
  }
  if (baseManifest) return baseManifest
  return worldExperience(world).kind === 'tavern' ? moonlitTavernTheme : cyberCompanyTheme
}
