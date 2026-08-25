import type { CharacterSkillAction, CharacterSkillDescriptor } from '@dsh-cyber/contracts/skill-runtime'

import type {
  CharacterSkillActionProposal,
  CharacterSkillAdapter,
  CharacterSkillExecutionContext,
  CharacterSkillExecutionResult,
  CharacterSkillMatchContext,
} from './skill-adapter.js'

export const SMART_HOME_CONTROL_SKILL = 'smart-home.control'
export const HOME_ASSISTANT_ADAPTER_ID = 'builtin.home-assistant'

const REQUEST_TIMEOUT_MS = 10_000

const DESCRIPTOR: CharacterSkillDescriptor = {
  id: SMART_HOME_CONTROL_SKILL,
  displayName: '智能家居控制',
  summary: '通过宿主配置的 Home Assistant 执行有限设备控制；凭据永不进入角色、Prompt 或动作记录。',
  adapterId: HOME_ASSISTANT_ADAPTER_ID,
  risks: ['external-side-effect'],
  supportsScheduling: true,
  persistentApproval: 'exact-target',
}

export interface HomeAssistantSkillAdapterOptions {
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
}

export class HomeAssistantSkillAdapter implements CharacterSkillAdapter {
  readonly id = HOME_ASSISTANT_ADAPTER_ID
  readonly descriptors = [DESCRIPTOR] as const
  readonly #env: NodeJS.ProcessEnv
  readonly #fetch: typeof globalThis.fetch

  constructor(options: HomeAssistantSkillAdapterOptions = {}) {
    this.#env = options.env ?? process.env
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  propose(context: CharacterSkillMatchContext): CharacterSkillActionProposal[] {
    if (!context.grantedSkillIds.includes(SMART_HOME_CONTROL_SKILL)) return []
    const intents = smartHomeIntents(context.prompt)
    if (intents.length === 0) return []
    const scheduledFor = requestedTime(context.prompt, context.now)
    return intents.map((intent) => ({
      skillId: SMART_HOME_CONTROL_SKILL,
      adapterId: this.id,
      action: intent.action,
      target: intent.target,
      label: actionLabel(intent.action, intent.target),
      risk: 'external-side-effect',
      authorization: 'explicit-user-request',
      parameters: {},
      ...(scheduledFor === undefined ? {} : { scheduledFor }),
    }))
  }

  preflight(action: CharacterSkillAction) {
    return homeAssistantConfig(this.#env, action.target) === undefined
      ? { ready: false, detail: 'Home Assistant 连接或对应设备实体尚未配置' }
      : { ready: true }
  }

  async execute(
    action: CharacterSkillAction,
    context: CharacterSkillExecutionContext,
  ): Promise<CharacterSkillExecutionResult> {
    const config = homeAssistantConfig(this.#env, action.target)
    if (config === undefined) {
      return {
        status: 'waiting-for-integration',
        detail: '动作已保存在本地，但尚未配置 Home Assistant 连接或对应设备实体，未伪造执行结果',
      }
    }

    const [domain, service] = action.action.split('.')
    if (!domain || !service) return { status: 'failed', detail: '技能动作格式无效，未执行外部请求' }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await this.#fetch(`${config.baseUrl}/api/services/${domain}/${service}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ entity_id: config.entityId }),
        signal: controller.signal,
      })
      if (!response.ok) {
        return { status: 'failed', detail: `Home Assistant 拒绝了动作（HTTP ${response.status}）` }
      }
      return { status: 'executed', detail: `已通过 Home Assistant 执行 ${action.label}` }
    } catch (error) {
      return {
        status: 'outcome-unknown',
        detail: error instanceof Error && error.name === 'AbortError'
          ? 'Home Assistant 请求超时，外部动作结果未知；不得自动重试'
          : 'Home Assistant 连接中断，外部动作结果未知；不得自动重试',
      }
    } finally {
      clearTimeout(timeout)
      void context.now
    }
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

function homeAssistantConfig(
  env: NodeJS.ProcessEnv,
  target: string,
): { baseUrl: string; token: string; entityId: string } | undefined {
  const rawBaseUrl = env.DSH_CYBER_HOME_ASSISTANT_URL
  const token = env.DSH_CYBER_HOME_ASSISTANT_TOKEN
  const entityId = target === 'air-conditioner'
    ? env.DSH_CYBER_HOME_AIR_CONDITIONER
    : target === 'music-player'
      ? env.DSH_CYBER_HOME_MUSIC_PLAYER
      : undefined
  const baseUrl = rawBaseUrl === undefined ? undefined : safeIntegrationBaseUrl(rawBaseUrl)
  if (!baseUrl || !token || !entityId) return undefined
  return { baseUrl, token, entityId }
}

function safeIntegrationBaseUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.username || url.password || url.hash) return undefined
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateHost(url.hostname))) return undefined
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  return url.toString().replace(/\/$/, '')
}

function isPrivateHost(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.local')) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (ipv4 === null) return hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:')
  const octets = ipv4.slice(1).map(Number)
  if (octets.some((octet) => octet > 255)) return false
  const [first, second] = octets
  return first === 10
    || first === 127
    || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
}

function actionLabel(action: string, target: string): string {
  const device = target === 'air-conditioner' ? '空调' : target === 'music-player' ? '音乐播放器' : target
  if (action.endsWith('turn_on')) return `开启${device}`
  if (action.endsWith('turn_off')) return `关闭${device}`
  if (action.endsWith('media_play')) return `播放${device}`
  if (action.endsWith('media_pause')) return `暂停${device}`
  return `${device} · ${action}`
}
