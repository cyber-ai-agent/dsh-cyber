import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { MossTtsProvider } from '../src/voice/tts/moss-tts-provider.js'

describe('MossTtsProvider sidecar protocol', () => {
  it('keeps the sidecar warm and returns PCM audio', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-moss-provider-'))
    const sidecar = join(root, 'fake-sidecar.mjs')
    await writeFile(sidecar, `
      import { createInterface } from 'node:readline';
      if (process.env.PYTHONIOENCODING !== 'utf-8' || process.env.PYTHONUTF8 !== '1') process.exit(2);
      process.stdout.write(JSON.stringify({ type: 'ready', voices: ['Junhao'] }) + '\\n');
      const lines = createInterface({ input: process.stdin });
      lines.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.text === '等待') return;
        const chunks = [new Float32Array([0, 0.25]), new Float32Array([-0.25, 0])];
        for (let sequence = 0; sequence < chunks.length; sequence += 1) {
          process.stdout.write(JSON.stringify({ type: 'audio', id: request.id, sequence, sampleRate: 24000, pcmBase64: Buffer.from(chunks[sequence].buffer).toString('base64') }) + '\\n');
        }
        process.stdout.write(JSON.stringify({ type: 'done', id: request.id, sequence: chunks.length, voice: request.voice }) + '\\n');
      });
    `, 'utf8')
    const provider = new MossTtsProvider(root, { executable: process.execPath, sidecar, startupTimeoutMs: 2_000, requestTimeoutMs: 2_000 })
    await provider.prepare()
    expect(provider.state).toBe('ready')
    expect(provider.voices).toEqual(['Junhao'])
    const warmPid = provider.processId
    expect(warmPid).toEqual(expect.any(Number))
    const chunks = []
    for await (const chunk of provider.synthesize({ requestId: 'moss-test', text: '你好', voiceId: 'moss:Junhao', speed: 1 })) chunks.push(chunk)
    expect(chunks).toHaveLength(3)
    expect(chunks.map((chunk) => ({ sequence: chunk.sequence, final: chunk.final }))).toEqual([
      { sequence: 0, final: false },
      { sequence: 1, final: false },
      { sequence: 2, final: true },
    ])
    expect(chunks.flatMap((chunk) => Array.from(chunk.pcm ?? []))).toEqual([0, 0.25, -0.25, 0])

    const controller = new AbortController()
    const interrupted = (async () => {
      for await (const _chunk of provider.synthesize({ requestId: 'moss-interrupt', text: '等待', voiceId: 'moss:Junhao', speed: 1, signal: controller.signal })) { /* consume */ }
    })()
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await expect(interrupted).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(provider.state).toBe('ready'), { timeout: 2_000 })
    expect(provider.processId).toBe(warmPid)

    const nextChunks = []
    for await (const chunk of provider.synthesize({ requestId: 'moss-next', text: '你好', voiceId: 'moss:Junhao', speed: 1 })) nextChunks.push(chunk)
    expect(nextChunks.length).toBeGreaterThan(0)
    expect(provider.processId).toBe(warmPid)
    await provider.dispose()
    expect(provider.processId).toBeUndefined()
  })

  it('terminates and recovers the runtime after a request timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-moss-timeout-'))
    const sidecar = join(root, 'timeout-sidecar.mjs')
    await writeFile(sidecar, `
      import { createInterface } from 'node:readline';
      process.stdout.write(JSON.stringify({ type: 'ready', voices: ['Junhao'] }) + '\\n');
      const lines = createInterface({ input: process.stdin });
      lines.on('line', (line) => {
        const request = JSON.parse(line);
        if (request.text === 'timeout') return;
        process.stdout.write(JSON.stringify({ type: 'audio', id: request.id, sequence: 0, sampleRate: 24000, pcmBase64: Buffer.from(new Float32Array([0.2]).buffer).toString('base64') }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'done', id: request.id, sequence: 1 }) + '\\n');
      });
    `, 'utf8')
    const provider = new MossTtsProvider(root, { executable: process.execPath, sidecar, startupTimeoutMs: 2_000, requestTimeoutMs: 30 })
    await provider.prepare()
    const firstPid = provider.processId
    const timedOut = (async () => {
      for await (const _chunk of provider.synthesize({ requestId: 'moss-timeout', text: 'timeout', voiceId: 'moss:Junhao', speed: 1 })) { /* consume */ }
    })()
    await expect(timedOut).rejects.toMatchObject({ name: 'AbortError' })
    expect(provider.processId).toBeUndefined()

    await provider.prepare()
    expect(provider.processId).toEqual(expect.any(Number))
    expect(provider.processId).not.toBe(firstPid)
    const recovered = []
    for await (const chunk of provider.synthesize({ requestId: 'moss-recovered', text: '恢复', voiceId: 'moss:Junhao', speed: 1 })) recovered.push(chunk)
    expect(recovered.some((chunk) => chunk.final)).toBe(true)
    await provider.dispose()
  })
})
