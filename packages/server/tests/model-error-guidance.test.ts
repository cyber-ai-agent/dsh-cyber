import { describe, expect, it } from 'vitest'

import { agentTurnFailureMessage } from '../src/http/errors.js'
import { classifyTurnFailure, friendlyRuntimeErrorMessage } from '../src/services/model-interaction-service.js'

describe('model turn failure guidance', () => {
  it('gives a concrete recovery path for each known failure kind', () => {
    expect(agentTurnFailureMessage('authentication')).toContain('重新填写密钥')
    expect(agentTurnFailureMessage('model-not-found')).toContain('重新获取模型列表')
    expect(agentTurnFailureMessage('rate-limited')).toContain('额度')
    expect(agentTurnFailureMessage('timeout')).toContain('接口地址')
    expect(agentTurnFailureMessage('unreachable')).toContain('代理/网络')
  })

  it('routes unknown upstream failures to diagnostics instead of repeating a generic configuration guess', () => {
    const message = agentTurnFailureMessage('unknown')
    expect(message).toContain('模型交互日志')
    expect(message).toContain('状态码')
    expect(message).toContain('接口协议')
    expect(message).toContain('推理模式')
    expect(message).not.toContain('请检查 API 密钥、接口地址和模型 ID 后重试')
  })

  it('turns persisted-session collisions into actionable Chinese diagnostics', () => {
    const raw = 'session "employee-1" already has a persisted log on disk that does not match this live session (id collision)'
    expect(classifyTurnFailure(raw)).toBe('session-recovery')
    expect(friendlyRuntimeErrorMessage(raw)).toContain('本地模型会话恢复')
    expect(friendlyRuntimeErrorMessage(raw)).toContain('请重新发送')
    expect(friendlyRuntimeErrorMessage(raw)).not.toContain('persisted log')
  })
})
