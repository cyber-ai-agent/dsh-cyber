import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

import { HttpError } from './errors.js'

export async function serveWebAsset(
  response: ServerResponse,
  webRoot: string,
  pathname: string,
): Promise<boolean> {
  let relativePath: string
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'
  } catch {
    throw new HttpError(400, 'invalid_path', 'Invalid URL path')
  }
  if (relativePath.includes('\0') || relativePath.split(/[\\/]/).includes('..')) {
    throw new HttpError(400, 'invalid_path', 'Invalid URL path')
  }
  const root = resolve(webRoot)
  let target = resolve(root, relativePath)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new HttpError(400, 'invalid_path', 'Invalid URL path')
  }
  let bytes: Buffer
  try {
    bytes = await readFile(target)
  } catch (error) {
    if (!isMissingFile(error) || extname(relativePath) !== '') return false
    target = join(root, 'index.html')
    try {
      bytes = await readFile(target)
    } catch (fallbackError) {
      if (isMissingFile(fallbackError)) return false
      throw fallbackError
    }
  }
  const extension = extname(target).toLowerCase()
  const contentType = ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
  } as Record<string, string>)[extension] ?? 'application/octet-stream'
  const immutable = relativePath.startsWith('assets/') && /-[A-Za-z0-9_-]{8,}\./.test(relativePath)
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': bytes.byteLength,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      'frame-src https: http://127.0.0.1:* http://localhost:*',
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(bytes)
  return true
}

export function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
