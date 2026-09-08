import type { WorkSession, WorkSessionParticipant } from '@dsh-cyber/contracts'
import { api } from '../../api.js'

export async function loadTaskSession(worldId: string, sessionId: string): Promise<{ session: WorkSession; participantIds: string[] }> {
  const [sessionResult, participantResult] = await Promise.all([
    api<{ items: WorkSession[] }>(`/api/worlds/${encodeURIComponent(worldId)}/sessions`),
    api<{ items: WorkSessionParticipant[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/participants`),
  ])
  const session = sessionResult.items.find((item) => item.id === sessionId)
  if (session === undefined) throw new Error('任务群聊尚未进入当前世界会话列表，请稍后重试。')
  return {
    session,
    participantIds: participantResult.items.filter((item) => item.kind === 'employee').map((item) => item.participantId),
  }
}
