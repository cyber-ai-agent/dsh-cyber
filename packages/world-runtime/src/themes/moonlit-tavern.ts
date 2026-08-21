import type { WorldThemeManifestV1 } from '@dsh-cyber/contracts'

import { cyberCompanyTheme } from './cyber-company.js'

export const moonlitTavernTheme: WorldThemeManifestV1 = {
  schemaVersion: 1,
  id: 'dsh-cyber.tavern.moonlit',
  version: '1.0.0',
  templateId: 'tavern',
  displayName: '月影酒馆 · 雨夜大厅',
  renderer: 'pixi-2d',
  terminology: {
    world: '酒馆',
    participant: '角色',
    session: '同桌会话',
    milestone: '人物事迹',
  },
  assets: [
    {
      id: 'tavern-scene',
      src: '/assets/moonlit-tavern-world.png',
      kind: 'image',
      preload: true,
      pixelArt: false,
    },
    cyberCompanyTheme.assets[1]!,
  ],
  actorSets: cyberCompanyTheme.actorSets,
  scenes: [
    {
      id: 'moonlit-hall',
      displayName: '月影酒馆大厅',
      size: { width: 1792, height: 1024 },
      cameraBounds: { x: 0, y: 0, width: 1792, height: 1024 },
      safeArea: { x: 40, y: 40, width: 1712, height: 944 },
      layers: [
        {
          id: 'tavern-interior',
          assetId: 'tavern-scene',
          destination: { x: 0, y: 0, width: 1792, height: 1024 },
          zIndex: 0,
        },
      ],
      anchors: [
        { id: 'spawn', position: { x: 900, y: 930 }, facing: 'north', capacity: 8, tags: ['spawn'] },
        { id: 'bar', position: { x: 725, y: 470 }, facing: 'north', capacity: 3, tags: ['work', 'talk'] },
        { id: 'fireplace', position: { x: 300, y: 585 }, facing: 'west', capacity: 2, tags: ['idle', 'talk'] },
        { id: 'window-booth', position: { x: 1_280, y: 585 }, facing: 'north', capacity: 3, tags: ['idle', 'talk'] },
        { id: 'notice-board', position: { x: 1_545, y: 470 }, facing: 'east', capacity: 2, tags: ['work', 'inspect'] },
        { id: 'meeting-west', position: { x: 760, y: 760 }, facing: 'east', capacity: 1, tags: ['meeting'] },
        { id: 'meeting-east', position: { x: 1_050, y: 760 }, facing: 'west', capacity: 1, tags: ['meeting'] },
        { id: 'meeting-south', position: { x: 905, y: 900 }, facing: 'north', capacity: 2, tags: ['meeting'] },
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
          id: 'tavern-bar',
          kind: 'bar',
          displayName: '月影吧台',
          bounds: { x: 430, y: 250, width: 540, height: 260 },
          approachAnchorIds: ['bar'],
          actions: [{ id: 'talk', label: '与吧台角色交谈' }],
          zIndex: 150,
        },
        {
          id: 'round-table',
          kind: 'meeting-table',
          displayName: '壁炉圆桌',
          bounds: { x: 630, y: 545, width: 570, height: 390 },
          approachAnchorIds: ['meeting-west', 'meeting-east', 'meeting-south'],
          actions: [{ id: 'start-meeting', label: '召集同桌会话' }],
          zIndex: 170,
        },
        {
          id: 'notice-board',
          kind: 'notice-board',
          displayName: '委托告示板',
          bounds: { x: 1_450, y: 235, width: 210, height: 300 },
          approachAnchorIds: ['notice-board'],
          actions: [{ id: 'assign-task', label: '发布委托' }, { id: 'inspect', label: '查看线索' }],
          zIndex: 160,
        },
        {
          id: 'fireplace',
          kind: 'fireplace',
          displayName: '旧石壁炉',
          bounds: { x: 90, y: 240, width: 350, height: 390 },
          approachAnchorIds: ['fireplace'],
          actions: [{ id: 'talk', label: '围炉交谈' }],
          zIndex: 145,
        },
      ],
      growthSlots: [
        { id: 'tavern-skill', category: 'skill', position: { x: 1_505, y: 330 }, zIndex: 130 },
        { id: 'tavern-delivery', category: 'delivery', position: { x: 1_555, y: 330 }, zIndex: 130 },
        { id: 'tavern-promotion', category: 'promotion', position: { x: 1_605, y: 330 }, zIndex: 130 },
      ],
    },
  ],
  activityMapping: cyberCompanyTheme.activityMapping,
}
