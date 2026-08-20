import type { ServerResponse } from 'node:http'

export function writeSse(
  response: ServerResponse,
  event: string,
  value: unknown,
  id?: string,
): void {
  if (response.writableEnded || response.destroyed) return
  if (id !== undefined) response.write(`id: ${id}\n`)
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

export function isSseSequence(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))
}

export function sseSequence(value: string | null | undefined): number {
  return value !== null && value !== undefined && isSseSequence(value) ? Number(value) : 0
}
