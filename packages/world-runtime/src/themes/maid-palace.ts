import type { WorldThemeManifestV1 } from '@dsh-cyber/contracts'

import { cyberCompanyTheme } from './cyber-company.js'

export const maidPalaceTheme: WorldThemeManifestV1 = {
  schemaVersion: 1,
  id: 'dsh-cyber.maid.palace',
  version: '1.0.0',
  templateId: 'maid-atelier',
  displayName: '深海女仆工坊 · 月光大厅',
  renderer: 'pixi-2d',
  terminology: {
    world: '工坊',
    participant: '女仆/执事',
    session: '工坊事务',
    milestone: '殿堂记录',
  },
  assets: [
    {
      id: 'maid-palace-scene',
      src: '/assets/skins/maid-palace-night.webp',
      kind: 'image',
      preload: true,
      pixelArt: false,
    },
    cyberCompanyTheme.assets[1]!,
  ],
  actorSets: cyberCompanyTheme.actorSets,
  scenes: [
    {
      id: 'maid-palace-hall',
      displayName: '深海工坊大厅',
      size: { width: 1792, height: 1120 },
      cameraBounds: { x: 0, y: 0, width: 1792, height: 1120 },
      safeArea: { x: 40, y: 40, width: 1712, height: 1040 },
      layers: [
        {
          id: 'maid-palace-interior',
          assetId: 'maid-palace-scene',
          destination: { x: 0, y: 0, width: 1792, height: 1120 },
          zIndex: 0,
        },
      ],
      anchors: [
        { id: 'spawn', position: { x: 896, y: 1033 }, facing: 'north', capacity: 8, tags: ['spawn'] },
        { id: 'whale-crest', position: { x: 896, y: 383 }, facing: 'south', capacity: 4, tags: ['spawn', 'meeting'] },
        { id: 'fireplace', position: { x: 380, y: 733 }, facing: 'east', capacity: 3, tags: ['idle', 'talk'] },
        { id: 'tea-cart', position: { x: 430, y: 917 }, facing: 'north', capacity: 2, tags: ['idle', 'talk'] },
        { id: 'desk-front', position: { x: 1200, y: 900 }, facing: 'north', capacity: 2, tags: ['work', 'write'] },
        { id: 'desk-mid', position: { x: 1160, y: 683 }, facing: 'north', capacity: 2, tags: ['work', 'inspect'] },
        { id: 'desk-back', position: { x: 1100, y: 483 }, facing: 'north', capacity: 2, tags: ['work', 'inspect'] },
        { id: 'bookshelf-left', position: { x: 520, y: 467 }, facing: 'north', capacity: 2, tags: ['inspect', 'work'] },
      ],
      navigation: {
        origin: { x: 0, y: 0 },
        cellSize: 64,
        columns: 28,
        rows: 21,
        blocked: [],
      },
      interactables: [
        {
          id: 'whale-altar',
          kind: 'altar',
          displayName: '深海星穹纹章',
          bounds: { x: 736, y: 267, width: 320, height: 217 },
          approachAnchorIds: ['whale-crest'],
          actions: [{ id: 'start-meeting', label: '召集工坊全员协作' }],
          zIndex: 150,
        },
        {
          id: 'fireplace-lounge',
          kind: 'lounge',
          displayName: '壁炉茶歇沙龙',
          bounds: { x: 220, y: 600, width: 340, height: 267 },
          approachAnchorIds: ['fireplace', 'tea-cart'],
          actions: [{ id: 'talk', label: '在壁炉旁对话' }],
          zIndex: 160,
        },
        {
          id: 'scholar-desk',
          kind: 'desk',
          displayName: '欧式红木书桌',
          bounds: { x: 1060, y: 767, width: 320, height: 217 },
          approachAnchorIds: ['desk-front'],
          actions: [{ id: 'assign-task', label: '委派工坊事务' }],
          zIndex: 170,
        },
      ],
      growthSlots: [
        { id: 'palace-skill', category: 'skill', position: { x: 1480, y: 350 }, zIndex: 130 },
        { id: 'palace-delivery', category: 'delivery', position: { x: 1540, y: 350 }, zIndex: 130 },
        { id: 'palace-promotion', category: 'promotion', position: { x: 1600, y: 350 }, zIndex: 130 },
      ],
    },
  ],
  activityMapping: cyberCompanyTheme.activityMapping,
}
