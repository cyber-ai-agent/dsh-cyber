import { readJson, requiredNumber, requiredString } from '../http/request.js'
import { Router } from '../http/router.js'
import { writeJson } from '../http/response.js'
import type { LocalTtsAssetService } from '../services/local-tts-asset-service.js'
import { once } from 'node:events'

export function registerLocalTtsRoutes(router: Router, service: LocalTtsAssetService): void {
  router.get('/api/local-tts/status', async ({ response }) => writeJson(response, 200, await service.status()))
  router.get('/api/local-tts/models', async ({ response }) => writeJson(response, 200, { models: await service.models() }))
  router.post(/^\/api\/local-tts\/models\/([^/]+)\/install$/, async ({ response, params }) => writeJson(response, 202, { model: await service.installModel(params[0]!) }))
  router.post(/^\/api\/local-tts\/models\/([^/]+)\/cancel$/, async ({ response, params }) => { await service.cancelModelInstall(params[0]!); writeJson(response, 200, { cancelled: true }) })
  router.delete(/^\/api\/local-tts\/models\/([^/]+)$/, async ({ response, params }) => { await service.removeModel(params[0]!); writeJson(response, 200, { removed: true }) })
  router.post('/api/local-tts/synthesize', async ({ request, response }) => {
    const body = await readJson(request, 16 * 1024)
    const audio = await service.synthesize({
      text: requiredString(body, 'text'),
      speakerId: requiredNumber(body, 'speakerId'),
      speed: requiredNumber(body, 'speed'),
    })
    response.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': audio.wav.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Audio-Duration': audio.duration.toFixed(3),
      'X-Audio-Sample-Rate': String(audio.sampleRate),
      'X-Audio-Peak': audio.peak.toFixed(6),
    })
    response.end(audio.wav)
  })
  router.post('/api/local-tts/stream', async ({ request, response }) => {
    const body = await readJson(request, 16 * 1024)
    const input = {
      text: requiredString(body, 'text'),
      speakerId: requiredNumber(body, 'speakerId'),
      speed: requiredNumber(body, 'speed'),
      ...(body.provider === 'moss' ? { provider: 'moss' as const, voiceId: typeof body.voiceId === 'string' ? body.voiceId : 'moss:Junhao' } : {}),
    }
    const controller = new AbortController()
    response.once('close', () => { if (!response.writableEnded) controller.abort() })
    response.writeHead(200, {
      'Content-Type': 'application/vnd.dsh.voice-pcm',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    for await (const chunk of service.stream({
      ...input,
      signal: controller.signal,
    })) {
      if (chunk.pcm === undefined) continue
      const header = Buffer.allocUnsafe(20)
      header.write('DSHV', 0); header.writeUInt32LE(chunk.sequence, 4); header.writeUInt32LE(chunk.sampleRate, 8)
      header.writeUInt32LE(chunk.pcm.length, 12); header.writeUInt32LE(chunk.final ? 1 : 0, 16)
      const payload = Buffer.from(chunk.pcm.buffer, chunk.pcm.byteOffset, chunk.pcm.byteLength)
      if (!response.write(Buffer.concat([header, payload]))) await once(response, 'drain')
    }
    response.end()
  })
}
