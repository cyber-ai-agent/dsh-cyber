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

export const sakuraShrineManifest: WorldThemeManifestV1 = {
  schemaVersion: 1,
  id: 'dsh-cyber.sakura.shrine',
  version: '1.0.0',
  templateId: 'sakura-shrine',
  displayName: '千樱神殿 · 樱落古院',
  renderer: 'pixi-2d',
  terminology: {
    world: '神社',
    participant: '巫女/侍者',
    session: '神前会话',
    milestone: '神社绘马',
  },
  assets: [
    {
      id: 'sakura-scene',
      src: '/assets/skins/sakura-shrine-world.jpg',
      kind: 'image',
      preload: true,
      pixelArt: false,
    },
    cyberCompanyTheme.assets[1]!,
  ],
  actorSets: cyberCompanyTheme.actorSets,
  scenes: [
    {
      id: 'sakura-courtyard',
      displayName: '千樱古院大殿',
      size: { width: 1792, height: 1008 },
      cameraBounds: { x: 0, y: 0, width: 1792, height: 1008 },
      safeArea: { x: 40, y: 40, width: 1712, height: 928 },
      layers: [
        {
          id: 'shrine-exterior',
          assetId: 'sakura-scene',
          destination: { x: 0, y: 0, width: 1792, height: 1008 },
          zIndex: 0,
        },
      ],
      anchors: [
        { id: 'spawn', position: { x: 740, y: 920 }, facing: 'north', capacity: 8, tags: ['spawn'] },
        { id: 'torii-walk', position: { x: 700, y: 680 }, facing: 'north', capacity: 3, tags: ['work', 'talk'] },
        { id: 'shrine-pavilion', position: { x: 1250, y: 720 }, facing: 'west', capacity: 3, tags: ['work', 'talk'] },
        { id: 'stone-lantern', position: { x: 240, y: 840 }, facing: 'east', capacity: 2, tags: ['idle', 'inspect'] },
        { id: 'chouzusha', position: { x: 420, y: 780 }, facing: 'north', capacity: 2, tags: ['work', 'inspect'] },
        { id: 'meeting-courtyard', position: { x: 950, y: 760 }, facing: 'south', capacity: 4, tags: ['meeting'] },
      ],
      navigation: {
        origin: { x: 0, y: 0 },
        cellSize: 64,
        columns: 28,
        rows: 16,
        blocked: [],
      },
      interactables: [
        {
          id: 'shrine-main-hall',
          kind: 'meeting-table',
          displayName: '神苑祈愿台',
          bounds: { x: 1100, y: 550, width: 420, height: 320 },
          approachAnchorIds: ['shrine-pavilion', 'meeting-courtyard'],
          actions: [{ id: 'start-meeting', label: '召集神前祈愿与会谈' }],
          zIndex: 160,
        },
        {
          id: 'ema-board',
          kind: 'notice-board',
          displayName: '千樱绘马牌架',
          bounds: { x: 300, y: 680, width: 260, height: 220 },
          approachAnchorIds: ['chouzusha'],
          actions: [{ id: 'assign-task', label: '悬挂绘马任务' }, { id: 'inspect', label: '查看祈愿' }],
          zIndex: 150,
        },
      ],
      growthSlots: [
        { id: 'sakura-skill', category: 'skill', position: { x: 1280, y: 480 }, zIndex: 130 },
      ],
    },
  ],
  activityMapping: cyberCompanyTheme.activityMapping,
}

export const starlitWitchManifest: WorldThemeManifestV1 = {
  schemaVersion: 1,
  id: 'dsh-cyber.starlit.witch',
  version: '1.0.0',
  templateId: 'starlit-witch',
  displayName: '星月魔女 · 秘术工坊',
  renderer: 'pixi-2d',
  terminology: {
    world: '工坊',
    participant: '使魔/魔女',
    session: '秘术研讨',
    milestone: '魔法印记',
  },
  assets: [
    {
      id: 'witch-scene',
      src: '/assets/skins/starlit-witch-world.jpg',
      kind: 'image',
      preload: true,
      pixelArt: false,
    },
    cyberCompanyTheme.assets[1]!,
  ],
  actorSets: cyberCompanyTheme.actorSets,
  scenes: [
    {
      id: 'witch-atelier-hall',
      displayName: '魔女星象密室',
      size: { width: 1792, height: 1008 },
      cameraBounds: { x: 0, y: 0, width: 1792, height: 1008 },
      safeArea: { x: 40, y: 40, width: 1712, height: 928 },
      layers: [
        {
          id: 'atelier-interior',
          assetId: 'witch-scene',
          destination: { x: 0, y: 0, width: 1792, height: 1008 },
          zIndex: 0,
        },
      ],
      anchors: [
        { id: 'spawn', position: { x: 900, y: 920 }, facing: 'north', capacity: 8, tags: ['spawn'] },
        { id: 'astrolabe', position: { x: 900, y: 640 }, facing: 'north', capacity: 3, tags: ['work', 'talk'] },
        { id: 'alchemy-table', position: { x: 1380, y: 820 }, facing: 'west', capacity: 3, tags: ['work', 'talk'] },
        { id: 'fireplace-seat', position: { x: 260, y: 840 }, facing: 'east', capacity: 2, tags: ['idle', 'talk'] },
        { id: 'spellbook-archive', position: { x: 500, y: 680 }, facing: 'north', capacity: 2, tags: ['inspect', 'work'] },
        { id: 'meeting-astrolabe', position: { x: 900, y: 780 }, facing: 'south', capacity: 4, tags: ['meeting'] },
      ],
      navigation: {
        origin: { x: 0, y: 0 },
        cellSize: 64,
        columns: 28,
        rows: 16,
        blocked: [],
      },
      interactables: [
        {
          id: 'witch-alchemy-desk',
          kind: 'meeting-table',
          displayName: '魔药研制台',
          bounds: { x: 1180, y: 680, width: 480, height: 300 },
          approachAnchorIds: ['alchemy-table', 'meeting-astrolabe'],
          actions: [{ id: 'start-meeting', label: '开启研讨与共鸣' }],
          zIndex: 160,
        },
        {
          id: 'celestial-astrolabe',
          kind: 'notice-board',
          displayName: '星轨浑天仪',
          bounds: { x: 740, y: 460, width: 320, height: 380 },
          approachAnchorIds: ['astrolabe'],
          actions: [{ id: 'assign-task', label: '布置观星课题' }, { id: 'inspect', label: '解读星象' }],
          zIndex: 155,
        },
      ],
      growthSlots: [
        { id: 'witch-skill', category: 'skill', position: { x: 1400, y: 450 }, zIndex: 130 },
      ],
    },
  ],
  activityMapping: cyberCompanyTheme.activityMapping,
}

export const neonCyberManifest: WorldThemeManifestV1 = {
  schemaVersion: 1,
  id: 'dsh-cyber.neon.cyber',
  version: '1.0.0',
  templateId: 'neon-cyber',
  displayName: '霓虹幻城 · 虚拟电波站',
  renderer: 'pixi-2d',
  terminology: {
    world: '电波站',
    participant: '主播/特工',
    session: '频段通信',
    milestone: '高光回放',
  },
  assets: [
    {
      id: 'neon-scene',
      src: '/assets/skins/neon-cyber-world.jpg',
      kind: 'image',
      preload: true,
      pixelArt: false,
    },
    cyberCompanyTheme.assets[1]!,
  ],
  actorSets: cyberCompanyTheme.actorSets,
  scenes: [
    {
      id: 'streamer-studio',
      displayName: '霓虹全息演播室',
      size: { width: 1792, height: 1008 },
      cameraBounds: { x: 0, y: 0, width: 1792, height: 1008 },
      safeArea: { x: 40, y: 40, width: 1712, height: 928 },
      layers: [
        {
          id: 'studio-interior',
          assetId: 'neon-scene',
          destination: { x: 0, y: 0, width: 1792, height: 1008 },
          zIndex: 0,
        },
      ],
      anchors: [
        { id: 'spawn', position: { x: 800, y: 920 }, facing: 'north', capacity: 8, tags: ['spawn'] },
        { id: 'stream-desk', position: { x: 1050, y: 760 }, facing: 'north', capacity: 3, tags: ['work', 'talk'] },
        { id: 'city-window', position: { x: 360, y: 760 }, facing: 'south', capacity: 3, tags: ['idle', 'inspect'] },
        { id: 'server-rack', position: { x: 1550, y: 840 }, facing: 'west', capacity: 2, tags: ['work', 'inspect'] },
        { id: 'meeting-studio', position: { x: 750, y: 780 }, facing: 'south', capacity: 4, tags: ['meeting'] },
      ],
      navigation: {
        origin: { x: 0, y: 0 },
        cellSize: 64,
        columns: 28,
        rows: 16,
        blocked: [],
      },
      interactables: [
        {
          id: 'streamer-control-deck',
          kind: 'meeting-table',
          displayName: '电竞全息主控台',
          bounds: { x: 860, y: 580, width: 460, height: 320 },
          approachAnchorIds: ['stream-desk', 'meeting-studio'],
          actions: [{ id: 'start-meeting', label: '发起全域电波连麦' }],
          zIndex: 160,
        },
        {
          id: 'neon-server-array',
          kind: 'notice-board',
          displayName: '阵列数据机柜',
          bounds: { x: 1440, y: 640, width: 260, height: 300 },
          approachAnchorIds: ['server-rack'],
          actions: [{ id: 'assign-task', label: '调度频段任务' }, { id: 'inspect', label: '查看监控' }],
          zIndex: 150,
        },
      ],
      growthSlots: [
        { id: 'neon-skill', category: 'skill', position: { x: 1480, y: 480 }, zIndex: 130 },
      ],
    },
  ],
  activityMapping: cyberCompanyTheme.activityMapping,
}

export const whiteWhaleMaidenManifest: WorldThemeManifestV1 = {
  schemaVersion: 1,
  id: 'dsh-cyber.white.whale',
  version: '1.0.0',
  templateId: 'white-whale',
  displayName: '白鲸圣女 · 纯白极光',
  renderer: 'pixi-2d',
  terminology: {
    world: '水下圣殿',
    participant: '圣女/侍者',
    session: '海音祈祷',
    milestone: '珍珠誓约',
  },
  assets: [
    {
      id: 'white-whale-scene',
      src: '/assets/skins/white-whale-maiden.jpg',
      kind: 'image',
      preload: true,
      pixelArt: false,
    },
    cyberCompanyTheme.assets[1]!,
  ],
  actorSets: cyberCompanyTheme.actorSets,
  scenes: [
    {
      id: 'white-crystal-palace',
      displayName: '水晶极光圣殿',
      size: { width: 1792, height: 1008 },
      cameraBounds: { x: 0, y: 0, width: 1792, height: 1008 },
      safeArea: { x: 40, y: 40, width: 1712, height: 928 },
      layers: [
        {
          id: 'crystal-interior',
          assetId: 'white-whale-scene',
          destination: { x: 0, y: 0, width: 1792, height: 1008 },
          zIndex: 0,
        },
      ],
      anchors: [
        { id: 'spawn', position: { x: 800, y: 920 }, facing: 'north', capacity: 8, tags: ['spawn'] },
        { id: 'crystal-altar', position: { x: 1150, y: 740 }, facing: 'north', capacity: 3, tags: ['work', 'talk'] },
        { id: 'whale-bay', position: { x: 400, y: 720 }, facing: 'south', capacity: 3, tags: ['idle', 'inspect'] },
        { id: 'pillar-aisle', position: { x: 1550, y: 840 }, facing: 'west', capacity: 2, tags: ['work', 'inspect'] },
        { id: 'meeting-altar', position: { x: 850, y: 800 }, facing: 'south', capacity: 4, tags: ['meeting'] },
      ],
      navigation: {
        origin: { x: 0, y: 0 },
        cellSize: 64,
        columns: 28,
        rows: 16,
        blocked: [],
      },
      interactables: [
        {
          id: 'crystal-prayer-desk',
          kind: 'meeting-table',
          displayName: '水下祈愿圣台',
          bounds: { x: 960, y: 560, width: 440, height: 320 },
          approachAnchorIds: ['crystal-altar', 'meeting-altar'],
          actions: [{ id: 'start-meeting', label: '发起圣殿共鸣会谈' }],
          zIndex: 160,
        },
        {
          id: 'shell-chime-shrine',
          kind: 'notice-board',
          displayName: '海音贝壳留音壁',
          bounds: { x: 300, y: 620, width: 280, height: 260 },
          approachAnchorIds: ['whale-bay'],
          actions: [{ id: 'assign-task', label: '留置祈祷信标' }, { id: 'inspect', label: '聆听白鲸海音' }],
          zIndex: 150,
        },
      ],
      growthSlots: [
        { id: 'white-skill', category: 'skill', position: { x: 1200, y: 460 }, zIndex: 130 },
      ],
    },
  ],
  activityMapping: cyberCompanyTheme.activityMapping,
}

export const blackOrcaMaidenManifest: WorldThemeManifestV1 = {
  schemaVersion: 1,
  id: 'dsh-cyber.black.orca',
  version: '1.0.0',
  templateId: 'black-orca',
  displayName: '漆黑虎鲸 · 深渊机能',
  renderer: 'pixi-2d',
  terminology: {
    world: '深渊舰桥',
    participant: '领航员/特工',
    session: '声呐连线',
    milestone: '深渊日志',
  },
  assets: [
    {
      id: 'black-orca-scene',
      src: '/assets/skins/black-orca-maiden.jpg',
      kind: 'image',
      preload: true,
      pixelArt: false,
    },
    cyberCompanyTheme.assets[1]!,
  ],
  actorSets: cyberCompanyTheme.actorSets,
  scenes: [
    {
      id: 'abyssal-bridge-deck',
      displayName: '深渊机能观景台',
      size: { width: 1792, height: 1008 },
      cameraBounds: { x: 0, y: 0, width: 1792, height: 1008 },
      safeArea: { x: 40, y: 40, width: 1712, height: 928 },
      layers: [
        {
          id: 'abyssal-interior',
          assetId: 'black-orca-scene',
          destination: { x: 0, y: 0, width: 1792, height: 1008 },
          zIndex: 0,
        },
      ],
      anchors: [
        { id: 'spawn', position: { x: 850, y: 920 }, facing: 'north', capacity: 8, tags: ['spawn'] },
        { id: 'bridge-helm', position: { x: 1200, y: 720 }, facing: 'north', capacity: 3, tags: ['work', 'talk'] },
        { id: 'sonar-deck', position: { x: 400, y: 740 }, facing: 'south', capacity: 3, tags: ['idle', 'inspect'] },
        { id: 'corridor-edge', position: { x: 1550, y: 840 }, facing: 'west', capacity: 2, tags: ['work', 'inspect'] },
        { id: 'meeting-deck', position: { x: 900, y: 800 }, facing: 'south', capacity: 4, tags: ['meeting'] },
      ],
      navigation: {
        origin: { x: 0, y: 0 },
        cellSize: 64,
        columns: 28,
        rows: 16,
        blocked: [],
      },
      interactables: [
        {
          id: 'abyssal-command-console',
          kind: 'meeting-table',
          displayName: '深渊全息主控台',
          bounds: { x: 1050, y: 550, width: 440, height: 320 },
          approachAnchorIds: ['bridge-helm', 'meeting-deck'],
          actions: [{ id: 'start-meeting', label: '发起深渊舰队会议' }],
          zIndex: 160,
        },
        {
          id: 'sonar-radar-matrix',
          kind: 'notice-board',
          displayName: '深渊声呐雷达矩阵',
          bounds: { x: 320, y: 640, width: 280, height: 260 },
          approachAnchorIds: ['sonar-deck'],
          actions: [{ id: 'assign-task', label: '下达深潜勘测令' }, { id: 'inspect', label: '扫描虎鲸生态' }],
          zIndex: 150,
        },
      ],
      growthSlots: [
        { id: 'orca-skill', category: 'skill', position: { x: 1250, y: 440 }, zIndex: 130 },
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
  {
    id: 'sakura-shrine',
    displayName: '千樱神殿',
    description: '樱落古院 · 绯粉霞光 · 朱红鸟居与和风祈愿神苑',
    author: '官方内置',
    source: 'builtin',
    tokens: {
      accentColor: '#f472b6',
      accentSoft: 'rgba(244, 114, 182, 0.16)',
      accentStrong: '#fb7185',
      pageBackground: '#130a12',
      panelBackground: 'rgba(28, 14, 26, 0.94)',
      panelBorder: 'rgba(244, 114, 182, 0.42)',
      textColor: '#fff1f2',
      mutedTextColor: '#f472b6',
      ownerBubbleColor: '#38142b',
      characterBubbleColor: '#200c19',
      backdropImage: '/assets/skins/sakura-shrine-world.jpg',
      backdropOpacity: 0.93,
      worldMapImage: '/assets/skins/sakura-shrine-world.jpg',
    },
    runtimeManifest: sakuraShrineManifest,
  },
  {
    id: 'starlit-witch',
    displayName: '星月魔女',
    description: '秘术工坊 · 幽夜星金 · 星象浑天仪与魔导炼金密室',
    author: '官方内置',
    source: 'builtin',
    tokens: {
      accentColor: '#c084fc',
      accentSoft: 'rgba(192, 132, 252, 0.16)',
      accentStrong: '#e879f9',
      pageBackground: '#0c0817',
      panelBackground: 'rgba(20, 14, 38, 0.94)',
      panelBorder: 'rgba(192, 132, 252, 0.42)',
      textColor: '#faf5ff',
      mutedTextColor: '#c084fc',
      ownerBubbleColor: '#28134a',
      characterBubbleColor: '#170b2c',
      backdropImage: '/assets/skins/starlit-witch-world.jpg',
      backdropOpacity: 0.93,
      worldMapImage: '/assets/skins/starlit-witch-world.jpg',
    },
    runtimeManifest: starlitWitchManifest,
  },
  {
    id: 'neon-cyber',
    displayName: '霓虹电波',
    description: '虚拟演播 · 赛博姬电波 · 全息频谱与未来电竞工作室',
    author: '官方内置',
    source: 'builtin',
    tokens: {
      accentColor: '#22d3ee',
      accentSoft: 'rgba(34, 211, 238, 0.16)',
      accentStrong: '#f43f5e',
      pageBackground: '#050a12',
      panelBackground: 'rgba(10, 18, 30, 0.94)',
      panelBorder: 'rgba(34, 211, 238, 0.45)',
      textColor: '#ecfeff',
      mutedTextColor: '#22d3ee',
      ownerBubbleColor: '#0b2e3a',
      characterBubbleColor: '#071b24',
      backdropImage: '/assets/skins/neon-cyber-world.jpg',
      backdropOpacity: 0.93,
      worldMapImage: '/assets/skins/neon-cyber-world.jpg',
    },
    runtimeManifest: neonCyberManifest,
  },
  {
    id: 'white-whale',
    displayName: '白鲸圣女',
    description: '极地纯白 · 极光冰蓝 · 纯白丝袜鲸鱼娘与水下极光圣殿',
    author: '官方内置',
    source: 'builtin',
    tokens: {
      accentColor: '#38bdf8',
      accentSoft: 'rgba(56, 189, 248, 0.18)',
      accentStrong: '#bae6fd',
      pageBackground: '#081324',
      panelBackground: 'rgba(10, 24, 46, 0.93)',
      panelBorder: 'rgba(186, 230, 253, 0.5)',
      textColor: '#f0f9ff',
      mutedTextColor: '#7dd3fc',
      ownerBubbleColor: '#0c365c',
      characterBubbleColor: '#0e223e',
      backdropImage: '/assets/skins/white-whale-maiden.jpg',
      backdropOpacity: 0.93,
      worldMapImage: '/assets/skins/white-whale-maiden.jpg',
    },
    runtimeManifest: whiteWhaleMaidenManifest,
  },
  {
    id: 'black-orca',
    displayName: '漆黑虎鲸',
    description: '深渊机能 · 魅影黑丝 · 虎鲸娘电光与未来深潜舰桥（鲸鱼娘专属）',
    author: '官方内置',
    source: 'builtin',
    tokens: {
      accentColor: '#00f2ff',
      accentSoft: 'rgba(0, 242, 255, 0.18)',
      accentStrong: '#f43f5e',
      pageBackground: '#040810',
      panelBackground: 'rgba(7, 13, 24, 0.94)',
      panelBorder: 'rgba(0, 242, 255, 0.45)',
      textColor: '#f1f5f9',
      mutedTextColor: '#38bdf8',
      ownerBubbleColor: '#09283e',
      characterBubbleColor: '#0a121e',
      backdropImage: '/assets/skins/black-orca-maiden.jpg',
      backdropOpacity: 0.93,
      worldMapImage: '/assets/skins/black-orca-maiden.jpg',
    },
    runtimeManifest: blackOrcaMaidenManifest,
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
  const base = baseManifest ?? (worldExperience(world).kind === 'tavern' ? moonlitTavernTheme : cyberCompanyTheme)
  const sceneImage = theme.tokens.worldMapImage ?? theme.tokens.backdropImage
  if (sceneImage === undefined) return base
  const assetId = `${theme.id}-shared-scene`
  return {
    ...base,
    id: `${base.id}:${theme.id}`,
    displayName: theme.displayName,
    assets: [
      { id: assetId, src: sceneImage, kind: 'image', preload: true, pixelArt: false },
      ...base.assets.filter((asset) => asset.id !== assetId),
    ],
    scenes: base.scenes.map((scene) => ({
      ...scene,
      layers: scene.layers.map((layer, index) => index === 0 ? { ...layer, assetId } : layer),
    })),
  }
}
