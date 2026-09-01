import type { UiLocale } from '@dsh-cyber/contracts'
import { getUiLocale } from './i18n/runtime.js'

const requestFailureMessages: Record<UiLocale, string> = {
  'zh-CN': '请求失败，请稍后重试。',
  'zh-TW': '請求失敗，請稍後再試。',
  'en-US': 'The request failed. Please try again.',
  'ja-JP': 'リクエストに失敗しました。もう一度お試しください。',
  'ko-KR': '요청에 실패했습니다. 다시 시도해 주세요.',
  'es-ES': 'La solicitud falló. Inténtalo de nuevo.',
  'fr-FR': 'La requête a échoué. Veuillez réessayer.',
  'de-DE': 'Die Anfrage ist fehlgeschlagen. Bitte versuchen Sie es erneut.',
  'pt-BR': 'A solicitação falhou. Tente novamente.',
  'ru-RU': 'Не удалось выполнить запрос. Повторите попытку.',
  'ar-SA': 'فشل الطلب. يُرجى المحاولة مرة أخرى.',
  'hi-IN': 'अनुरोध विफल हुआ। कृपया फिर से प्रयास करें।',
}

/**
 * Machine-readable part of a server failure.
 *
 * The server's `message` is authored in Chinese, so it is only shown verbatim
 * where that reads correctly. Everything a caller needs in order to build its
 * own localized copy — the stable `code`, the `error.<code>` message key and any
 * structured `details` the route attached — travels in every locale.
 */
export interface ApiErrorDetail {
  code?: string
  messageKey?: string
  details?: Readonly<Record<string, unknown>>
}

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly messageKey?: string
  readonly details?: Readonly<Record<string, unknown>>

  constructor(status: number, message: string, detail?: string | ApiErrorDetail) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    const resolved: ApiErrorDetail = typeof detail === 'string' ? { code: detail } : detail ?? {}
    if (resolved.code !== undefined) this.code = resolved.code
    if (resolved.messageKey !== undefined) this.messageKey = resolved.messageKey
    if (resolved.details !== undefined) this.details = resolved.details
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? 'GET'
  const requiresJsonHeader = !['GET', 'HEAD'].includes(method)
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(!requiresJsonHeader && init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as
      | { error?: { code?: string; message?: string; messageKey?: string; details?: unknown } }
      | undefined
    const locale = getUiLocale()
    throw new ApiError(
      response.status,
      locale === 'zh-CN' ? (body?.error?.message ?? requestFailureMessages[locale]) : requestFailureMessages[locale],
      serverErrorDetail(body?.error),
    )
  }
  return response.json() as Promise<T>
}

function serverErrorDetail(error: { code?: string; messageKey?: string; details?: unknown } | undefined): ApiErrorDetail {
  const detail: ApiErrorDetail = {}
  if (error === undefined) return detail
  if (typeof error.code === 'string') detail.code = error.code
  if (typeof error.messageKey === 'string') detail.messageKey = error.messageKey
  else if (typeof error.code === 'string') detail.messageKey = `error.${error.code}`
  if (typeof error.details === 'object' && error.details !== null && !Array.isArray(error.details)) {
    detail.details = error.details as Record<string, unknown>
  }
  return detail
}

export function jsonBody(value: unknown): Pick<RequestInit, 'body' | 'method'> {
  return { method: 'POST', body: JSON.stringify(value) }
}
