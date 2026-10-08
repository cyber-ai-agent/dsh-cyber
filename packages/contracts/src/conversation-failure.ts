/** Safe, bounded product guidance. Never echo an arbitrary exception or provider payload. */
export function conversationTurnFailure(errorCode: string): { code: string; message: string } {
  const kind = errorCode.startsWith('runtime-') ? errorCode.slice('runtime-'.length) : ''
  if (['context-limit', 'authentication', 'model-not-found', 'rate-limited', 'timeout', 'unreachable', 'unknown'].includes(kind)) {
    return { code: `runtime-${kind}`, message: runtimeFailureMessage(kind) }
  }
  return {
    code: 'turn-failed',
    message: '处理消息时发生错误。请检查消息内容和相关设置；确认已执行的操作后再决定是否重试。',
  }
}

function runtimeFailureMessage(kind: string): string {
  switch (kind) {
    case 'context-limit':
      return '本次输入和角色资料过长，超过当前模型可用上下文。请缩短消息、角色设定或资料，或切换更大上下文的模型后重试。'
    case 'authentication':
      return 'API 密钥被模型服务拒绝。请打开“设置 → 模型”重新填写密钥，并先获取模型列表确认连接成功。'
    case 'model-not-found':
      return '接口已连接，但当前模型 ID 不存在或无权访问。请在“设置 → 模型”重新获取模型列表并选择可用模型。'
    case 'rate-limited':
      return '模型服务正在限流或账户额度不足。请稍后重试，或检查服务商额度并切换可用模型。'
    case 'timeout':
      return '模型服务响应超时。请先确认接口地址可以访问；网络正常时可稍后重试，或降低当前推理档位。'
    case 'unreachable':
      return '模型服务不可达或上游暂时不可用。请检查接口地址、代理/网络和服务状态；如果模型列表也无法获取，请先修复连接。'
    default:
      return '上游返回了暂未识别的模型错误。请打开“设置 → 模型 → 模型交互日志”查看最近失败的状态码和错误码；若模型列表可正常获取但对话仍失败，重点检查接口协议、推理模式兼容性和模型 ID。'
  }
}
