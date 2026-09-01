import type { WorldThemeManifestV1 } from '@dsh-cyber/contracts'

import { cyberCompanyTheme } from './cyber-company.js'

/**
 * AI 学院 — an online teaching workplace, not a repainted office.
 *
 * The scenario, not the picture, is what a Theme carries. Everything a teaching
 * world needs is expressed through the shipped v1 contract:
 *
 * - `terminology` is the world vocabulary (course / syllabus / lesson / cohort /
 *   question / assessment / teaching material / knowledge map / course result).
 *   Renderers and world copy read it; nothing new was invented to hold it.
 * - the scene `anchors` and `interactables` are the teaching loop made spatial:
 *   知识拆解 → 课程计划 → 教学材料 → 答疑 → 知识图 → 课程结果. Their tags are the
 *   semantic surface `compileWorldSemantics` turns into zones, facilities and
 *   slots, and the same tags are what a Character Blueprint Embodiment binds to.
 * - the interactable `kind` values (`blackboard`, `syllabus-board`,
 *   `question-desk`, `knowledge-graph-wall`, `milestone-wall`) are this theme's
 *   declaration of the result surfaces it prefers in the scene area.
 *   Declaration only — rendering those surfaces is not this theme's job.
 *
 * The default scene is a 2D university classroom drawn from a small vector
 * asset. No 3D, no VRM, no generated art.
 */
export const aiAcademyTheme: WorldThemeManifestV1 = {
  schemaVersion: 1,
  id: 'dsh-cyber.academy.classroom',
  version: '1.0.0',
  templateId: 'ai-academy',
  displayName: 'AI 学院 · 大学教室',
  renderer: 'pixi-2d',
  terminology: {
    world: '学院',
    participant: '教研角色',
    session: '课堂',
    milestone: '教学履历',
    course: '课程',
    syllabus: '课程大纲',
    lesson: '课时',
    cohort: '班级',
    learner: '学员',
    question: '问题',
    answer: '答疑',
    assessment: '评估',
    teachingMaterial: '教学材料',
    knowledgePoint: '知识点',
    knowledgeMap: '知识图',
    artifact: '课程结果',
    assignment: '教学任务',
    workflow: ['知识拆解', '课程计划', '教学材料', '答疑', '知识图', '课程结果'],
    rules: [
      '先把知识点拆解清楚，再排课程计划；没有拆解就不写教案。',
      '教学材料必须标明面向的学员基础、课时长度与要达成的可检验目标。',
      '讲解引用的事实、公式与出处保留来源；不确定的内容标为待核实，不写成定论。',
      '答疑先诊断学员卡在哪一步，再给最小可验证的下一步，不代替学员完成作业。',
      '知识图只连接课程里真实讲过或验证过的知识点，不用推测补边。',
      '课程结果以学员可复用的材料交付，并说明尚未覆盖的知识点。',
    ],
  },
  assets: [
    {
      id: 'academy-classroom-scene',
      src: '/assets/skins/ai-academy-classroom.svg',
      kind: 'image',
      preload: true,
      pixelArt: false,
    },
    cyberCompanyTheme.assets[1]!,
  ],
  actorSets: cyberCompanyTheme.actorSets,
  scenes: [
    {
      id: 'university-classroom',
      displayName: '大学教室',
      size: { width: 1536, height: 1024 },
      cameraBounds: { x: 0, y: 0, width: 1536, height: 1024 },
      safeArea: { x: 32, y: 32, width: 1472, height: 960 },
      layers: [
        {
          id: 'classroom-interior',
          assetId: 'academy-classroom-scene',
          destination: { x: 0, y: 0, width: 1536, height: 1024 },
          zIndex: 0,
        },
      ],
      anchors: [
        { id: 'classroom-door', position: { x: 768, y: 990 }, facing: 'north', capacity: 8, tags: ['spawn', 'public', 'waiting'] },
        { id: 'lectern', position: { x: 768, y: 505 }, facing: 'north', capacity: 2, tags: ['work', 'administration', 'coordination', 'lectern', 'teaching', 'lesson'] },
        { id: 'syllabus-desk', position: { x: 260, y: 380 }, facing: 'north', capacity: 2, tags: ['work', 'administration', 'schedule', 'syllabus', 'course-plan'] },
        { id: 'breakdown-desk', position: { x: 250, y: 750 }, facing: 'north', capacity: 2, tags: ['work', 'research', 'knowledge', 'analysis', 'decomposition'] },
        { id: 'material-bench', position: { x: 1286, y: 750 }, facing: 'north', capacity: 2, tags: ['work', 'engineering', 'production', 'teaching-material', 'animation'] },
        { id: 'question-corner', position: { x: 225, y: 975 }, facing: 'north', capacity: 2, tags: ['work', 'operations', 'monitoring', 'question', 'tutoring', 'talk'] },
        { id: 'knowledge-graph', position: { x: 1296, y: 380 }, facing: 'north', capacity: 2, tags: ['inspect', 'research', 'knowledge', 'archive', 'graph'] },
        { id: 'result-showcase', position: { x: 1311, y: 975 }, facing: 'north', capacity: 2, tags: ['inspect', 'research', 'milestone', 'knowledge', 'archive', 'course-result'] },
        { id: 'cohort-west', position: { x: 560, y: 700 }, facing: 'east', capacity: 2, tags: ['meeting', 'conversation', 'cohort'] },
        { id: 'cohort-east', position: { x: 980, y: 700 }, facing: 'west', capacity: 2, tags: ['meeting', 'conversation', 'cohort'] },
        { id: 'cohort-south', position: { x: 770, y: 900 }, facing: 'north', capacity: 3, tags: ['meeting', 'conversation', 'cohort'] },
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
          id: 'knowledge-breakdown-desk',
          kind: 'workstation',
          displayName: '知识拆解台',
          bounds: { x: 110, y: 560, width: 280, height: 192 },
          approachAnchorIds: ['breakdown-desk'],
          actions: [
            { id: 'assign-task', label: '拆解知识点' },
            { id: 'inspect', label: '查看已拆解的知识点' },
          ],
          zIndex: 160,
        },
        {
          id: 'syllabus-board',
          kind: 'syllabus-board',
          displayName: '课程计划板',
          bounds: { x: 90, y: 118, width: 300, height: 212 },
          approachAnchorIds: ['syllabus-desk'],
          actions: [
            { id: 'assign-task', label: '制定课程计划' },
            { id: 'inspect', label: '查看课程大纲' },
          ],
          zIndex: 150,
        },
        {
          id: 'teaching-material-bench',
          kind: 'workstation',
          displayName: '教学材料工作台',
          bounds: { x: 1146, y: 560, width: 280, height: 192 },
          approachAnchorIds: ['material-bench'],
          actions: [
            { id: 'assign-task', label: '制作教学材料' },
            { id: 'inspect', label: '查看材料草稿' },
          ],
          zIndex: 160,
        },
        {
          id: 'question-desk',
          kind: 'question-desk',
          displayName: '答疑席',
          bounds: { x: 90, y: 800, width: 270, height: 200 },
          approachAnchorIds: ['question-corner'],
          actions: [
            { id: 'talk', label: '开始答疑' },
            { id: 'inspect', label: '查看待答疑问题' },
          ],
          zIndex: 170,
        },
        {
          id: 'knowledge-graph-wall',
          kind: 'knowledge-graph-wall',
          displayName: '知识图谱墙',
          bounds: { x: 1146, y: 118, width: 300, height: 212 },
          approachAnchorIds: ['knowledge-graph'],
          actions: [{ id: 'inspect', label: '查看知识图' }],
          zIndex: 150,
        },
        {
          id: 'course-result-showcase',
          kind: 'milestone-wall',
          displayName: '课程成果展台',
          bounds: { x: 1176, y: 800, width: 270, height: 200 },
          approachAnchorIds: ['result-showcase'],
          actions: [{ id: 'inspect', label: '查看课程结果' }],
          zIndex: 170,
        },
        {
          id: 'lecture-blackboard',
          kind: 'blackboard',
          displayName: '主讲黑板',
          bounds: { x: 456, y: 84, width: 624, height: 264 },
          approachAnchorIds: ['lectern'],
          actions: [
            { id: 'inspect', label: '查看板书' },
            { id: 'assign-task', label: '安排一节课' },
          ],
          zIndex: 140,
        },
        {
          id: 'cohort-seating',
          kind: 'meeting-table',
          displayName: '学员席',
          bounds: { x: 512, y: 590, width: 516, height: 310 },
          approachAnchorIds: ['cohort-west', 'cohort-east', 'cohort-south'],
          actions: [{ id: 'start-meeting', label: '开课并召集教研角色' }],
          zIndex: 165,
        },
      ],
      growthSlots: [
        { id: 'academy-skill', category: 'skill', position: { x: 1220, y: 776 }, zIndex: 130 },
        { id: 'academy-delivery', category: 'delivery', position: { x: 1280, y: 776 }, zIndex: 130 },
        { id: 'academy-promotion', category: 'promotion', position: { x: 1340, y: 776 }, zIndex: 130 },
      ],
    },
  ],
  activityMapping: cyberCompanyTheme.activityMapping,
}
