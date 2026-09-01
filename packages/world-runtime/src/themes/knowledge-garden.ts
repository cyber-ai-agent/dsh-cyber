import type { WorldThemeManifestV1 } from '@dsh-cyber/contracts'

import { cyberCompanyTheme } from './cyber-company.js'

/**
 * 知识花园 — a personal second brain, expressed as an application scenario.
 *
 * This theme deliberately builds *nothing* new: the world knowledge library
 * (collections / documents / chunks) and the world knowledge graph (entities,
 * claims, relations and the `KnowledgeEvidence` that backs them) already exist
 * and are among the most finished parts of the product. What was missing was a
 * scenario, a vocabulary and a cast that make tending them over time the point.
 *
 * - `terminology` is the garden vocabulary (来源 / 引用 / 条目 / 论断 / 资料集 /
 *   笔记 / 知识图谱 / 复看 / 整理成果). It also opts this scene into the shipped
 *   world result surface with `resultSurface` + the four lane labels — reusing
 *   E1's surface rather than adding a second one.
 * - the scene `anchors` and `interactables` are the tending loop made spatial:
 *   采集来源 → 归档资料 → 提炼条目 → 核验引用 → 连接知识图谱 → 复看维护. Their tags
 *   are the semantic surface `compileWorldSemantics` turns into zones,
 *   facilities and slots, and the same tags are what an Embodiment binds to.
 * - the world `rules` make 引用来源 a first-class obligation. A second brain is
 *   only worth having if every claim can name where it came from, so an
 *   unsourced statement is allowed to exist as a 待核实 note and is *not*
 *   allowed into the graph.
 *
 * Scope note, recorded honestly: knowledge in this product is scoped per world
 * end to end — every knowledge route is `/api/worlds/:worldId/knowledge/...`
 * and the repositories key on `worldId`. There is no cross-world read, merge or
 * copy primitive today, so "不同世界知识整理" is expressed here as a *rule* (each
 * garden tends its own knowledge; reuse goes out through an export and back in
 * through the existing library import) rather than as a promise this theme
 * cannot keep.
 *
 * The default scene is a 2D reading courtyard drawn from a small hand-authored
 * vector asset. No 3D, no VRM, no generated art.
 */
export const knowledgeGardenTheme: WorldThemeManifestV1 = {
  schemaVersion: 1,
  id: 'dsh-cyber.garden.study',
  version: '1.0.0',
  templateId: 'knowledge-garden',
  displayName: '知识花园 · 藏书庭院',
  renderer: 'pixi-2d',
  terminology: {
    world: '花园',
    participant: '整理角色',
    session: '整理会',
    milestone: '维护履历',
    source: '来源',
    citation: '引用',
    collection: '资料集',
    document: '资料',
    note: '笔记',
    entry: '条目',
    claim: '论断',
    evidence: '证据',
    conflict: '冲突',
    review: '复看',
    knowledgeMap: '知识图谱',
    artifact: '整理成果',
    assignment: '整理任务',
    // Opt into the world result surface shipped in E1. `generic` keeps its
    // copy neutral; the four lane labels below are this garden's own words.
    resultSurface: 'generic',
    resultSurfaceLabel: '花园成果',
    blackboard: '摘录板',
    knowledgeGraph: '知识图谱',
    lessonCards: '笔记卡片',
    resultMedia: '影像资料',
    workflow: ['采集来源', '归档资料', '提炼条目', '核验引用', '连接知识图谱', '复看维护'],
    rules: [
      '每一条论断都要能指到来源；指不到来源的内容只能作为待核实笔记留着，不进知识图谱。',
      '引用要落到可回溯的位置：资料与片段、会话与消息，或成果的具体版本；「资料里说过」不算来源。',
      '先保留原始资料再写摘要；摘要永远不覆盖原文，原文才是权威。',
      '说法冲突时并列保留双方并标出冲突，不用「最新的」或「多数的」替代可靠性判断。',
      '过时或被推翻的条目标为已废止并写清被谁取代，不删除历史。',
      '知识只属于当前花园；不读取也不写入别的世界的资料，需要复用时由用户导出再导入。',
      '找不到就说找不到，空的资料集就说是空的；不用推测补条目，也不假称已经整理完。',
    ],
  },
  assets: [
    {
      id: 'knowledge-garden-study-scene',
      src: '/assets/skins/knowledge-garden-study.svg',
      kind: 'image',
      preload: true,
      pixelArt: false,
    },
    cyberCompanyTheme.assets[1]!,
  ],
  actorSets: cyberCompanyTheme.actorSets,
  scenes: [
    {
      id: 'reading-courtyard',
      displayName: '藏书庭院',
      size: { width: 1536, height: 1024 },
      cameraBounds: { x: 0, y: 0, width: 1536, height: 1024 },
      safeArea: { x: 32, y: 32, width: 1472, height: 960 },
      layers: [
        {
          id: 'courtyard-interior',
          assetId: 'knowledge-garden-study-scene',
          destination: { x: 0, y: 0, width: 1536, height: 1024 },
          zIndex: 0,
        },
      ],
      anchors: [
        { id: 'garden-gate', position: { x: 768, y: 990 }, facing: 'north', capacity: 8, tags: ['spawn', 'public', 'waiting'] },
        { id: 'curation-desk', position: { x: 768, y: 505 }, facing: 'north', capacity: 2, tags: ['work', 'administration', 'coordination', 'curation', 'stewardship', 'archive'] },
        { id: 'collection-shelf', position: { x: 260, y: 380 }, facing: 'north', capacity: 2, tags: ['work', 'administration', 'archive', 'collection', 'catalog'] },
        { id: 'intake-desk', position: { x: 250, y: 750 }, facing: 'north', capacity: 2, tags: ['work', 'operations', 'monitoring', 'intake', 'source', 'collect'] },
        { id: 'citation-bench', position: { x: 1286, y: 750 }, facing: 'north', capacity: 2, tags: ['work', 'research', 'verification', 'citation', 'provenance', 'evidence'] },
        { id: 'graph-wall', position: { x: 1296, y: 380 }, facing: 'north', capacity: 2, tags: ['work', 'engineering', 'production', 'knowledge', 'graph', 'cartography', 'inspect'] },
        { id: 'note-shelf', position: { x: 225, y: 975 }, facing: 'north', capacity: 2, tags: ['inspect', 'research', 'notes', 'cards', 'archive'] },
        { id: 'result-showcase', position: { x: 1311, y: 975 }, facing: 'north', capacity: 2, tags: ['inspect', 'research', 'milestone', 'knowledge', 'archive', 'garden-result'] },
        { id: 'reading-west', position: { x: 560, y: 700 }, facing: 'east', capacity: 2, tags: ['meeting', 'conversation', 'review'] },
        { id: 'reading-east', position: { x: 980, y: 700 }, facing: 'west', capacity: 2, tags: ['meeting', 'conversation', 'review'] },
        { id: 'reading-south', position: { x: 770, y: 900 }, facing: 'north', capacity: 3, tags: ['meeting', 'conversation', 'review'] },
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
          id: 'source-intake-desk',
          kind: 'workstation',
          displayName: '来源采集台',
          bounds: { x: 110, y: 560, width: 280, height: 192 },
          approachAnchorIds: ['intake-desk'],
          actions: [
            { id: 'assign-task', label: '采集一份来源' },
            { id: 'inspect', label: '查看待归档的来源' },
          ],
          zIndex: 160,
        },
        {
          id: 'collection-bookshelf',
          kind: 'archive-shelf',
          displayName: '资料集书架',
          bounds: { x: 90, y: 118, width: 300, height: 212 },
          approachAnchorIds: ['collection-shelf'],
          actions: [
            { id: 'assign-task', label: '归档进资料集' },
            { id: 'inspect', label: '查看资料集' },
          ],
          zIndex: 150,
        },
        {
          id: 'citation-check-bench',
          kind: 'workstation',
          displayName: '来源核验台',
          bounds: { x: 1146, y: 560, width: 280, height: 192 },
          approachAnchorIds: ['citation-bench'],
          actions: [
            { id: 'assign-task', label: '核验一条论断的来源' },
            { id: 'inspect', label: '查看缺来源与冲突的条目' },
          ],
          zIndex: 160,
        },
        {
          id: 'note-card-shelf',
          kind: 'lesson-card-shelf',
          displayName: '笔记卡片架',
          bounds: { x: 90, y: 800, width: 270, height: 200 },
          approachAnchorIds: ['note-shelf'],
          actions: [
            { id: 'inspect', label: '查看笔记卡片' },
            { id: 'assign-task', label: '把资料提炼成条目' },
          ],
          zIndex: 170,
        },
        {
          id: 'knowledge-graph-wall',
          kind: 'knowledge-graph-wall',
          displayName: '知识图谱墙',
          bounds: { x: 1146, y: 118, width: 300, height: 212 },
          approachAnchorIds: ['graph-wall'],
          actions: [
            { id: 'inspect', label: '查看知识图谱' },
            { id: 'assign-task', label: '连接条目与关系' },
          ],
          zIndex: 150,
        },
        {
          id: 'garden-result-showcase',
          kind: 'milestone-wall',
          displayName: '整理成果展台',
          bounds: { x: 1176, y: 800, width: 270, height: 200 },
          approachAnchorIds: ['result-showcase'],
          actions: [{ id: 'inspect', label: '查看整理成果' }],
          zIndex: 170,
        },
        {
          id: 'excerpt-board',
          kind: 'blackboard',
          displayName: '摘录板',
          bounds: { x: 456, y: 84, width: 624, height: 264 },
          approachAnchorIds: ['curation-desk'],
          actions: [
            { id: 'inspect', label: '查看摘录与引用' },
            { id: 'assign-task', label: '安排一次整理' },
          ],
          zIndex: 140,
        },
        {
          id: 'reading-tables',
          kind: 'meeting-table',
          displayName: '阅读长桌',
          bounds: { x: 512, y: 590, width: 516, height: 310 },
          approachAnchorIds: ['reading-west', 'reading-east', 'reading-south'],
          actions: [{ id: 'start-meeting', label: '开一次复看会' }],
          zIndex: 165,
        },
      ],
      growthSlots: [
        { id: 'garden-skill', category: 'skill', position: { x: 1220, y: 776 }, zIndex: 130 },
        { id: 'garden-delivery', category: 'delivery', position: { x: 1280, y: 776 }, zIndex: 130 },
        { id: 'garden-promotion', category: 'promotion', position: { x: 1340, y: 776 }, zIndex: 130 },
      ],
    },
  ],
  activityMapping: cyberCompanyTheme.activityMapping,
}
