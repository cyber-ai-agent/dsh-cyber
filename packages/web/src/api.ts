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

export class ApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    if (code !== undefined) this.code = code
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
      | { error?: { code?: string; message?: string; messageKey?: string } }
      | undefined
    const locale = getUiLocale()
    throw new ApiError(
      response.status,
      locale === 'zh-CN' ? (body?.error?.message ?? requestFailureMessages[locale]) : requestFailureMessages[locale],
      body?.error?.code,
    )
  }
  return response.json() as Promise<T>
}

export function jsonBody(value: unknown): Pick<RequestInit, 'body' | 'method'> {
  return { method: 'POST', body: JSON.stringify(value) }
}
