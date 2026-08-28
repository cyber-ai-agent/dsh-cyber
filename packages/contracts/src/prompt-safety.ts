/**
 * The largest user-authored prompt accepted by the chat boundary.
 *
 * This is deliberately a character limit rather than a request-body limit:
 * attachments and other JSON fields must not be able to turn one prompt into
 * an unbounded model context. Array.from counts Unicode code points, so emoji,
 * CJK text and right-to-left scripts are each counted as one character.
 */
export const MAX_USER_PROMPT_CHARACTERS = 32_000

export type UserPromptValidationCode =
  | 'prompt_type_invalid'
  | 'prompt_required'
  | 'prompt_too_long'
  | 'prompt_control_character'

export class UserPromptValidationError extends Error {
  readonly code: UserPromptValidationCode

  constructor(code: UserPromptValidationCode, message: string) {
    super(message)
    this.name = 'UserPromptValidationError'
    this.code = code
  }
}

/**
 * Normalizes one user-authored chat prompt at the trust boundary.
 *
 * NFC preserves the user's visible text while making canonically equivalent
 * forms stable. Tabs and line breaks remain valid; other C0/C1 controls,
 * including NUL and DEL, are rejected. No natural-language keywords are
 * filtered: instruction-like text is still user data and must be handled by
 * the model's message hierarchy, not by lossy keyword matching.
 */
export function normalizeUserPrompt(value: unknown): string {
  if (typeof value !== 'string') {
    throw new UserPromptValidationError('prompt_type_invalid', '消息内容必须是文本')
  }

  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0) {
    throw new UserPromptValidationError('prompt_required', '消息内容不能为空')
  }

  const characterCount = countUnicodeCharacters(normalized)
  if (characterCount > MAX_USER_PROMPT_CHARACTERS) {
    throw new UserPromptValidationError(
      'prompt_too_long',
      `消息内容不能超过 ${MAX_USER_PROMPT_CHARACTERS} 个字符`,
    )
  }

  for (const character of normalized) {
    const codePoint = character.codePointAt(0)!
    if (isDangerousControlCodePoint(codePoint)) {
      throw new UserPromptValidationError('prompt_control_character', '消息内容包含不允许的控制字符')
    }
  }

  return normalized
}

export function countUnicodeCharacters(value: string): number {
  return Array.from(value).length
}

function isDangerousControlCodePoint(codePoint: number): boolean {
  // Keep horizontal tab, LF and CR so normal multiline composition remains
  // intact. Reject the rest of C0, plus DEL and the complete C1 range.
  if (codePoint <= 0x1f) return codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d
  return codePoint >= 0x7f && codePoint <= 0x9f
}
