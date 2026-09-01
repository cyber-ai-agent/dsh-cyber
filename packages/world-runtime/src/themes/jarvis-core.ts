import type { WorldThemeManifestV1 } from '@dsh-cyber/contracts'

import { cyberCompanyTheme } from './cyber-company.js'

/**
 * Jarvis Core — a general personal AI assistant hub.
 *
 * What distinguishes this scenario from the other themes is **delegation**: the
 * owner brings one personal need and the hub routes it. Everything below is
 * that loop, expressed through the shipped v1 contract only:
 *
 * - `terminology` is the hub vocabulary (请求 / 归属 / 委派 / 受理角色 / 日程 /
 *   资料 / 简报 / 汇总回报). It also declares which result surface the scene area
 *   should present through the already shipped `resultSurface` keys — this theme
 *   reuses that one surface instead of adding a second one, and asks for the
 *   generic (non-teaching) vocabulary with hub labels.
 * - the scene `anchors` and `interactables` are the delegation loop made
 *   spatial: 接收请求 (受理圆桌) → 判断归属 (归属判断板) → 委派 (委派主板 · 委派台)
 *   → 汇总回报 (汇总回报台). The delegate seats — 调研席 / 日程台 / 资料整理台 —
 *   are where a routed request actually lands. Those tags are the semantic
 *   surface `compileWorldSemantics` turns into zones, facilities and slots, and
 *   the same tags are what a Character Blueprint Embodiment binds to.
 * - 日程 is deliberately *not* a new mechanism. The 日程台 is the spatial handle
 *   on the world's existing Task Schedule machinery; nothing here schedules.
 *
 * The default scene is a 2D personal hub studio drawn from a small vector
 * asset. No 3D, no VRM, no generated art.
 */
export const jarvisCoreTheme: WorldThemeManifestV1 = {
  schemaVersion: 1,
  id: 'dsh-cyber.jarvis.hub',
  version: '1.0.0',
  templateId: 'jarvis-core',
  displayName: 'Jarvis Core · 个人中枢',
  renderer: 'pixi-2d',
  terminology: {
    world: '中枢',
    participant: '助理角色',
    session: '委派',
    milestone: '委派履历',
    request: '请求',
    intake: '受理',
    ownership: '归属',
    delegation: '委派',
    assignee: '受理角色',
    followUp: '跟进',
    schedule: '日程',
    material: '资料',
    brief: '简报',
    digest: '汇总回报',
    artifact: '交付结果',
    assignment: '个人任务',
    // Reuses the world scene's one result surface with hub vocabulary.
    resultSurface: 'generic',
    resultSurfaceLabel: '汇总回报',
    blackboard: '简报板',
    knowledgeGraph: '信息图',
    lessonCards: '结果卡片',
    resultMedia: '演示 · 影像',
    workflow: ['接收请求', '判断归属', '委派', '汇总回报'],
    rules: [
      '每个请求先落成一条能复述的请求记录，再判断归属；听不清就先问清楚，不替用户猜需求。',
      '归属只在这个中枢现有的角色之间判断；没有合适的角色就如实说没有，并说明缺的是什么能力，不硬塞给不合适的角色。',
      '委派必须写明交付物、验收标准与期限，且一次委派只对应一个负责角色，避免出现无人负责的事。',
      '需要定时或重复执行的事，用世界已有的任务计划（日程）落地；不在对话里口头承诺时间。',
      '汇总回报如实区分「已完成」「进行中」「被阻塞」「没有做」；没有做的事不写成已完成，空的就说空。',
      '中枢不代替用户完成对外动作（发送、支付、发布、删除），这类动作只给出可执行方案并等用户确认。',
      '个人资料只在当前中枢内流转，不跨世界读取，也不把私人信息写进对外交付物。',
    ],
  },
  assets: [
    {
      id: 'jarvis-hub-scene',
      src: '/assets/skins/jarvis-core-hub.svg',
      kind: 'image',
      preload: true,
      pixelArt: false,
    },
    cyberCompanyTheme.assets[1]!,
  ],
  actorSets: cyberCompanyTheme.actorSets,
  scenes: [
    {
      id: 'personal-hub-studio',
      displayName: '个人中枢工作室',
      size: { width: 1536, height: 1024 },
      cameraBounds: { x: 0, y: 0, width: 1536, height: 1024 },
      safeArea: { x: 32, y: 32, width: 1472, height: 960 },
      layers: [
        {
          id: 'hub-interior',
          assetId: 'jarvis-hub-scene',
          destination: { x: 0, y: 0, width: 1536, height: 1024 },
          zIndex: 0,
        },
      ],
      anchors: [
        { id: 'hub-entry', position: { x: 768, y: 990 }, facing: 'north', capacity: 8, tags: ['spawn', 'public', 'waiting'] },
        { id: 'delegation-desk', position: { x: 768, y: 505 }, facing: 'north', capacity: 2, tags: ['work', 'administration', 'coordination', 'delegation', 'dispatch'] },
        { id: 'triage-desk', position: { x: 260, y: 380 }, facing: 'north', capacity: 2, tags: ['work', 'administration', 'triage', 'ownership', 'intake'] },
        { id: 'research-carrel', position: { x: 250, y: 750 }, facing: 'north', capacity: 2, tags: ['work', 'research', 'knowledge', 'analysis', 'inquiry'] },
        { id: 'filing-bench', position: { x: 1286, y: 750 }, facing: 'north', capacity: 2, tags: ['work', 'engineering', 'production', 'organize', 'filing'] },
        { id: 'schedule-console', position: { x: 225, y: 975 }, facing: 'north', capacity: 2, tags: ['work', 'operations', 'monitoring', 'schedule', 'calendar', 'reminder'] },
        { id: 'index-wall', position: { x: 1296, y: 380 }, facing: 'north', capacity: 2, tags: ['inspect', 'research', 'knowledge', 'archive', 'index'] },
        { id: 'report-stand', position: { x: 1311, y: 975 }, facing: 'north', capacity: 2, tags: ['inspect', 'research', 'milestone', 'knowledge', 'archive', 'digest'] },
        { id: 'intake-west', position: { x: 598, y: 670 }, facing: 'east', capacity: 2, tags: ['meeting', 'conversation', 'intake'] },
        { id: 'intake-east', position: { x: 942, y: 670 }, facing: 'west', capacity: 2, tags: ['meeting', 'conversation', 'intake'] },
        { id: 'intake-south', position: { x: 770, y: 850 }, facing: 'north', capacity: 3, tags: ['meeting', 'conversation', 'intake'] },
        { id: 'window-bench', position: { x: 466, y: 560 }, facing: 'north', capacity: 2, tags: ['idle', 'rest', 'talk', 'social', 'public'] },
      ],
      navigation: {
        origin: { x: 0, y: 0 },
        cellSize: 64,
        columns: 24,
        rows: 16,
        blocked: [],
      },
      interactables: [
        {
          id: 'request-intake-table',
          kind: 'intake-table',
          displayName: '受理圆桌',
          bounds: { x: 512, y: 590, width: 516, height: 310 },
          approachAnchorIds: ['intake-west', 'intake-east', 'intake-south'],
          actions: [
            { id: 'talk', label: '说明一件要办的事' },
            { id: 'start-meeting', label: '接收请求并召集助理角色' },
          ],
          zIndex: 165,
        },
        {
          id: 'ownership-routing-board',
          kind: 'routing-board',
          displayName: '归属判断板',
          bounds: { x: 90, y: 118, width: 300, height: 212 },
          approachAnchorIds: ['triage-desk'],
          actions: [
            { id: 'assign-task', label: '判断这件事归谁' },
            { id: 'inspect', label: '查看归属判断依据' },
          ],
          zIndex: 150,
        },
        {
          id: 'delegation-board',
          kind: 'delegation-board',
          displayName: '委派主板',
          bounds: { x: 456, y: 84, width: 624, height: 264 },
          approachAnchorIds: ['delegation-desk'],
          actions: [
            { id: 'assign-task', label: '委派给一个助理角色' },
            { id: 'inspect', label: '查看在办委派与状态' },
          ],
          zIndex: 140,
        },
        {
          id: 'research-carrel-desk',
          kind: 'workstation',
          displayName: '调研席',
          bounds: { x: 110, y: 560, width: 280, height: 192 },
          approachAnchorIds: ['research-carrel'],
          actions: [
            { id: 'assign-task', label: '委派一次调研' },
            { id: 'inspect', label: '查看调研记录与来源' },
          ],
          zIndex: 160,
        },
        {
          id: 'schedule-console-desk',
          kind: 'schedule-console',
          displayName: '日程台',
          bounds: { x: 90, y: 800, width: 270, height: 200 },
          approachAnchorIds: ['schedule-console'],
          actions: [
            { id: 'assign-task', label: '把这件事排进日程' },
            { id: 'inspect', label: '查看已排的任务计划' },
          ],
          zIndex: 170,
        },
        {
          id: 'filing-organiser-bench',
          kind: 'workstation',
          displayName: '资料整理台',
          bounds: { x: 1146, y: 560, width: 280, height: 192 },
          approachAnchorIds: ['filing-bench'],
          actions: [
            { id: 'assign-task', label: '委派一次信息整理' },
            { id: 'inspect', label: '查看已整理的资料' },
          ],
          zIndex: 160,
        },
        {
          id: 'information-index-wall',
          kind: 'knowledge-index-wall',
          displayName: '信息索引墙',
          bounds: { x: 1146, y: 118, width: 300, height: 212 },
          approachAnchorIds: ['index-wall'],
          actions: [{ id: 'inspect', label: '查看信息图' }],
          zIndex: 150,
        },
        {
          id: 'summary-report-stand',
          kind: 'milestone-wall',
          displayName: '汇总回报台',
          bounds: { x: 1176, y: 800, width: 270, height: 200 },
          approachAnchorIds: ['report-stand'],
          actions: [{ id: 'inspect', label: '查看汇总回报' }],
          zIndex: 170,
        },
      ],
      growthSlots: [
        { id: 'jarvis-skill', category: 'skill', position: { x: 1220, y: 776 }, zIndex: 130 },
        { id: 'jarvis-delivery', category: 'delivery', position: { x: 1280, y: 776 }, zIndex: 130 },
        { id: 'jarvis-promotion', category: 'promotion', position: { x: 1340, y: 776 }, zIndex: 130 },
      ],
    },
  ],
  activityMapping: cyberCompanyTheme.activityMapping,
}
