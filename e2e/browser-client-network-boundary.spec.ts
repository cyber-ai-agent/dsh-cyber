import { createServer } from 'node:http'

import { expect, test } from '@playwright/test'

import {
  BrowserPolicy,
  PlaywrightBrowserClientFactory,
} from '../packages/server/lib/index.js'

test('keeps meta refresh inside the offline Browser rendering boundary', async () => {
  let networkHits = 0
  const probe = createServer((_request, response) => {
    networkHits += 1
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('Chromium must never reach this server')
  })
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (address === null || typeof address === 'string') throw new Error('Unable to bind Browser network probe')
  const url = `http://example.test:${address.port}/start`
  const factory = new PlaywrightBrowserClientFactory({
    documentFetcher: async () => ({
      url,
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Buffer.from(`<html><head><meta http-equiv="refresh" content="0; url=http://example.test:${address.port}/leak"></head><body>offline</body></html>`),
    }),
  })
  const client = await factory.create(new BrowserPolicy(), {
    url,
    hostname: 'example.test',
    pinnedAddress: '127.0.0.1',
  })

  try {
    await expect(client.read(url)).rejects.toMatchObject({ kind: 'non-readonly-request' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(networkHits).toBe(0)
  } finally {
    await client.close()
    await new Promise<void>((resolve, reject) => probe.close((error) => error === undefined ? resolve() : reject(error)))
  }
})
