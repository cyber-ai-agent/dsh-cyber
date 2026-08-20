import type { ServerResponse } from 'node:http'

export function writeJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(body)
}

export function writeBinary(
  response: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.byteLength,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(body)
}

export function writeWorkspaceFile(response: ServerResponse, body: Buffer, contentType: string): void {
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.byteLength,
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(body)
}

export function writeHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(body)
}
