export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as
      | { error?: { message?: string } }
      | undefined
    throw new ApiError(response.status, body?.error?.message ?? `Request failed: ${response.status}`)
  }
  return response.json() as Promise<T>
}

export function jsonBody(value: unknown): Pick<RequestInit, 'body' | 'method'> {
  return { method: 'POST', body: JSON.stringify(value) }
}

