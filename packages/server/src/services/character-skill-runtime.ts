import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { open, readFile, rename } from 'node:fs/promises'

import type { CharacterSkillAction, CharacterSkillResult } from '@dsh-cyber/contracts/creative-platform'
import type { SqliteStore } from '@dsh-cyber/persistence'

const SMART_HOME_SKILL = 'smart-home.control'
const TICK_MS = 30_000
const REQUEST_TIMEOUT_MS = 10_000

interface SkillActionFile {
  version: 1
  actions: CharacterSkillAction[]
}

export class CharacterSkillRuntime {
  readonly #store: SqliteStore
  readonly #path: string
  #timer: NodeJS.Timeout | undefined
  #ticking = false

  constructor(store: SqliteStore) {
    this.#store = store
    this.#path = join(dirname(dirname(store.databasePath)), 'skills', 'actions.json')
  }

  start(): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => void this.tick(), TICK_MS)
    this.#timer.unref()
  }

  async prepare(worldId: string, characterId: string, prompt: string, now = new Date()): Promise<CharacterSkillResult> {
    const employee = this.#store.getEmployee(characterId)
    if (employee === undefined || employee.worldId !== worldId || employee.status === 'archived') return { handled: false, actions: [] }
    const revision = this.#store.getEmployeeRevision(employee.id, employee.currentRevision)
    if (revision === undefined || !revision.skillGrants.includes(SMART_HOME_SKILL)) return { handled: false, actions: [] }
    const intents = smartHomeIntents(prompt)
    if (intents.length === 0) return { handled: false, actions: [] }

    const scheduledFor = requestedTime(prompt, now)
    const file = await this.#read()
    const actions: CharacterSkillAction[] = []
    for (const intent of intents) {
      const duplicate = file.actions.find((item) =>
        item.worldId === worldId
        && item.characterId === characterId
        && item.skillId === SMART_HOME_SKILL
        && item.action === intent.action
        && item.target === intent.target
        && item.scheduledFor === scheduledFor
        && Math.abs(now.getTime() - Date.parse(item.createdAt)) < 60_000,
      )
      if (duplicate !== undefined) {
        actions.push(duplicate)
        continue
      }
      const created: CharacterSkillAction = {
        id: randomUUID(),
        worldId,
        characterId,
        skillId: SMART_HOME_SKILL,
        action: intent.action,
        target: intent.target,
        ...(scheduledFor === undefined ? {} : { scheduledFor }),
        status: scheduledFor === undefined ? 'waiting-for-integration' : 'scheduled',
        detail: scheduledFor === undefined ? '正在检查智能家居连接' : `已创建本地计划，将在 ${localTimeLabel(scheduledFor)} 尝试执行`,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }
      if (scheduledFor === undefined) await this.#execute(created)
      file.actions.push(created)
      actions.push(created)
    }
    await this.#write(file)
    return {
      handled: true,
      skillId: SMART_HOME_SKILL,
      summary: skillSummary(actions),
      actions,
    }
  }

  async list(worldId: string): Promise<CharacterSkillAction[]> {
    return (await this.#read()).actions
      .filter((item) => item.worldId === worldId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async tick(now = new Date()): Promise<void> {
    if (this.#ticking) return
    this.#ticking = true
    try {
      const file = await this.#read()
      let changed = false
      for (const action of file.actions) {
        if (action.status !== 'scheduled' || action.scheduledFor === undefined || Date.parse(action.scheduledFor) > now.getTime()) continue
        const employee = this.#store.getEmployee(action.characterId)
        const revision = employee === undefined ? undefined : this.#store.getEmployeeRevision(employee.id, employee.currentRevision)
        if (
          employee === undefined
          || employee.status === 'archived'
          || employee.worldId !== action.worldId
          || revision === undefined
          || !revision.skillGrants.includes(action.skillId)
        ) {
          action.status = 'failed'
          action.detail = '计划执行前角色已不可用或技能授权已撤销'
          action.updatedAt = now.toISOString()
          changed = true
          continue
        }
        await this.#execute(action, now)
        changed = true
      }
      if (changed) await this.#write(file)
    } finally {
      this.#ticking = false
    }
  }

  async #execute(action: CharacterSkillAction, now = new Date()): Promise<void> {
    const config = homeAssistantConfig(action.target)
    if (config === undefined) {
      action.status = 'waiting-for-integration'
      action.detail = '计划已保存在本地，但尚未配置 Home Assistant 连接或对应设备实体，未伪造执行结果'
      action.updatedAt = now.toISOString()
      return
    }
    const [domain, service] = action.action.split('.')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${config.baseUrl}/api/services/${domain}/${service}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ entity_id: config.entityId }),
        signal: controller.signal,
      })
      if (!response.ok) {
        action.status = 'failed'
        action.detail = `Home Assistant 拒绝了动作（HTTP ${response.status}）`
      } else {
        action.status = 'executed'
        action.detail = `已通过 Home Assistant 执行 ${actionLabel(action.action, action.target)}`
      }
    } catch (error) {
      action.status = 'failed'
      action.detail = error instanceof Error && error.name === 'AbortError'
        ? 'Home Assistant 执行超时'
        : '无法连接 Home Assistant，动作未执行'
    } finally {
      clearTimeout(timeout)
      action.updatedAt = now.toISOString()
    }
  }

  async #read(): Promise<SkillActionFile> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')) as Partial<SkillActionFile>
      return parsed.version === 1 && Array.isArray(parsed.actions)
        ? { version: 1, actions: parsed.actions }
        : { version: 1, actions: [] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, actions: [] }
      throw error
    }
  }

  async #write(value: SkillActionFile): Promise<void> {
    const directory = dirname(this.#path)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.#path}.tmp-${randomUUID()}`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.#path)
  }
}

function smartHomeIntents(prompt: string): Array<{ action: string; target: string }> {
  const intents: Array<{ action: string; target: string }> = []
  if (/空调/.test(prompt)) {
    if (/(关闭|关掉|关上|停止)/.test(prompt)) intents.push({ action: 'climate.turn_off', target: 'air-conditioner' })
    else if (/(开启|打开|开空调|启动)/.test(prompt)) intents.push({ action: 'climate.turn_on', target: 'air-conditioner' })
  }
  if (/(音乐|歌曲|歌单|播放器)/.test(prompt)) {
    if (/(暂停|停止|关闭音乐|关掉音乐)/.test(prompt)) intents.push({ action: 'media_player.media_pause', target: 'music-player' })
    else if (/(播放|放点|放首|打开音乐|开启音乐)/.test(prompt)) intents.push({ action: 'media_player.media_play', target: 'music-player' })
  }
  return intents
}

function requestedTime(prompt: string, now: Date): string | undefined {
  const match = /(?:今天|今晚|到家|在)?\s*([01]?\d|2[0-3])[:：]([0-5]\d)/.exec(prompt)
  if (match === null) return undefined
  const target = new Date(now)
  target.setHours(Number(match[1]), Number(match[2]), 0, 0)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  return target.toISOString()
}

function homeAssistantConfig(target: string): { baseUrl: string; token: string; entityId: string } | undefined {
  const baseUrl = process.env.DSH_CYBER_HOME_ASSISTANT_URL?.replace(/\/+$/, '')
  const token = process.env.DSH_CYBER_HOME_ASSISTANT_TOKEN
  const entityId = target === 'air-conditioner'
    ? process.env.DSH_CYBER_HOME_AIR_CONDITIONER
    : process.env.DSH_CYBER_HOME_MUSIC_PLAYER
  if (!baseUrl || !token || !entityId || !/^https?:\/\//.test(baseUrl)) return undefined
  return { baseUrl, token, entityId }
}

function skillSummary(actions: CharacterSkillAction[]): string {
  return actions.map((item) => `${actionLabel(item.action, item.target)}：${item.detail}`).join('\n')
}

function actionLabel(action: string, target: string): string {
  const device = target === 'air-conditioner' ? '空调' : target === 'music-player' ? '音乐播放器' : target
  if (action.endsWith('turn_on')) return `开启${device}`
  if (action.endsWith('turn_off')) return `关闭${device}`
  if (action.endsWith('media_play')) return `播放${device}`
  if (action.endsWith('media_pause')) return `暂停${device}`
  return `${device} · ${action}`
}

function localTimeLabel(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
