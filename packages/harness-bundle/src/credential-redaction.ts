import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, PreToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  CREDENTIAL_VARIABLES_ENV,
  CredentialRedactor,
  parseCredentialVariableDescriptors,
  type JsonValue,
} from '@dsh-cyber/contracts'

/**
 * Install the last-mile credential guard for every DSH tool. A tool body may
 * use a real value at the execution boundary, while the model-facing content,
 * additional contexts, durable result and host notification receive the safe
 * variable reference.
 */
export function registerCredentialRedaction(ctx: Context): void {
  const descriptors = parseCredentialVariableDescriptors(process.env[CREDENTIAL_VARIABLES_ENV])
  const redactor = new CredentialRedactor(descriptors.flatMap((descriptor) => {
    const value = descriptor.envName === undefined ? undefined : process.env[descriptor.envName]
    return value === undefined || value === '' ? [] : [{ ...descriptor, value }]
  }))
  registerShellCredentialVariables(ctx, descriptors)

  // This wrapper also covers tool-pipeline failures that bypass the post
  // stage. It is the first boundary after a tool body returns.
  ctx.on('tools/execute', async (_exec, next) => sanitizeResult(await next(), redactor), { global: true })

  // A model-facing call must use the host variable reference. This prevents a
  // literal credential from being sent to a tool even when a prompt injection
  // tries to bypass the normal connection adapter.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (containsRegisteredCredential(exec.arguments, redactor)) {
      return { kind: 'deny', reason: '工具参数包含凭证原文，请使用宿主提供的受保护变量引用。' }
    }
    const decision = await next()
    return sanitizePreDecision(decision, redactor)
  }, { global: true })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    return sanitizeDecision(result, decision, redactor)
  }, { global: true })
}

interface ShellEnvironmentRegistry {
  register(input: {
    name: string
    variables: Record<string, { description: string }>
    resolve(execution: unknown): Readonly<Record<string, string>>
  }): () => void
}

/**
 * dsh-shell-env deliberately removes ambient DSH_* values before every shell
 * call. Register aliases through its contributor seam so the model can use a
 * variable without receiving the underlying value in its prompt.
 */
function registerShellCredentialVariables(
  ctx: Context,
  descriptors: readonly { ref: string; variable: string; envName?: string }[],
): void {
  const shellEnv = ctx.get('shellEnv') as ShellEnvironmentRegistry | undefined
  if (shellEnv === undefined) return
  const available = descriptors.filter((descriptor): descriptor is { ref: string; variable: string; envName: string } =>
    descriptor.envName !== undefined
    && descriptor.ref !== 'environment:DSH_CYBER_WORKER_TOKEN'
    && /^[A-Z_][A-Z0-9_]*$/.test(descriptor.envName),
  )
  if (available.length === 0) return
  shellEnv.register({
    name: 'dsh-cyber-credential-variables',
    variables: Object.fromEntries(available.map((descriptor) => [descriptor.envName, {
      description: `宿主凭证变量 ${descriptor.variable}；输出会自动恢复为变量引用。`,
    }])),
    resolve: () => Object.fromEntries(available.flatMap((descriptor) => {
      const value = process.env[descriptor.envName]
      return value === undefined ? [] : [[descriptor.envName, value]]
    })),
  })
}

function sanitizeDecision(
  result: Readonly<ToolExecutionResult>,
  decision: PostToolDecision,
  redactor: CredentialRedactor,
): PostToolDecision {
  const safeResultContent = redactContent(result.content, redactor)
  const resultContentChanged = JSON.stringify(safeResultContent) !== JSON.stringify(result.content)
  const safeResultContexts = redactContexts(result.additionalContexts, redactor)
  const resultContextsChanged = JSON.stringify(safeResultContexts) !== JSON.stringify(result.additionalContexts ?? [])
  const resultErrorChanged = result.isError && redactor.text(result.error.message) !== result.error.message

  if (decision.kind === 'block') {
    return {
      kind: 'block',
      feedback: redactContent(decision.feedback, redactor),
      ...mergeContexts(safeResultContexts, decision.additionalContexts, redactor),
    }
  }

  const decisionContexts = redactContexts(decision.additionalContexts, redactor)
  if ('value' in decision) {
    return {
      kind: 'accept',
      value: redactor.json(decision.value),
      ...mergeContexts(safeResultContexts, decisionContexts),
    }
  }

  if (result.isError && (resultErrorChanged || resultContentChanged)) {
    return {
      kind: 'block',
      feedback: safeResultContent,
      ...mergeContexts(safeResultContexts, decisionContexts),
    }
  }

  // Replacing the value gives PTC sub-dispatches the sanitized structured
  // result as well as the native rendered content. The tool output contract
  // remains the authority for rendering, so the value keeps its schema.
  if (!result.isError) {
    const safeValue = redactor.json(result.value)
    if (JSON.stringify(safeValue) !== JSON.stringify(result.value)) {
      return {
        kind: 'accept',
        value: safeValue,
        ...mergeContexts(safeResultContexts, decisionContexts),
      }
    }
  }

  const content = 'content' in decision
    ? redactContent(decision.content, redactor)
    : resultContentChanged ? safeResultContent : undefined
  if (content !== undefined || resultContextsChanged || decisionContexts.length > 0) {
    return {
      kind: 'accept',
      ...(content === undefined ? {} : { content }),
      ...mergeContexts(safeResultContexts, decisionContexts),
    }
  }
  return decision
}

function sanitizeResult(result: ToolExecutionResult, redactor: CredentialRedactor): ToolExecutionResult {
  const content = redactContent(result.content, redactor)
  const additionalContexts = redactContexts(result.additionalContexts, redactor)
  if (result.isError) {
    return {
      ...result,
      content,
      error: { ...result.error, message: redactor.text(result.error.message) },
      ...(result.meta === undefined ? {} : { meta: redactor.json(result.meta) }),
      ...(additionalContexts.length === 0 ? {} : { additionalContexts }),
    }
  }
  return {
    ...result,
    value: redactor.json(result.value),
    content,
    ...(result.meta === undefined ? {} : { meta: redactor.json(result.meta) }),
    ...(additionalContexts.length === 0 ? {} : { additionalContexts }),
  }
}

function sanitizePreDecision(decision: PreToolDecision, redactor: CredentialRedactor): PreToolDecision {
  if (decision.kind === 'allow') return decision
  if (decision.kind === 'deny') return { ...decision, reason: redactor.text(decision.reason) }
  if (decision.kind === 'cancel') return decision
  return { ...decision, ...(decision.reason === undefined ? {} : { reason: redactor.text(decision.reason) }) }
}

function containsRegisteredCredential(value: unknown, redactor: CredentialRedactor): boolean {
  if (value === null || typeof value !== 'object') return false
  const source = JSON.stringify(value)
  if (source === undefined) return false
  return JSON.stringify(redactor.json(value as JsonValue)) !== source
}

function redactContent(content: readonly ContentBlock[], redactor: CredentialRedactor): ContentBlock[] {
  return content.map((block) => redactor.json(block as unknown as JsonValue) as unknown as ContentBlock)
}

function redactContexts(
  contexts: readonly UserMessage[] | undefined,
  redactor: CredentialRedactor,
): UserMessage[] {
  return (contexts ?? []).map((context) => redactor.json(context as unknown as JsonValue) as unknown as UserMessage)
}

function mergeContexts(
  resultContexts: readonly UserMessage[],
  decisionContexts: readonly UserMessage[] | undefined,
  redactor?: CredentialRedactor,
): { additionalContexts?: UserMessage[] } {
  const merged = [
    ...resultContexts,
    ...(decisionContexts ?? []).map((context) => redactor === undefined ? context : redactor.json(context as unknown as JsonValue)),
  ]
  return merged.length === 0 ? {} : { additionalContexts: merged as UserMessage[] }
}
