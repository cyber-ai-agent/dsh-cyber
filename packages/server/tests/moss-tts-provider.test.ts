import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

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
        const pcm = new Float32Array([0, 0.25, -0.25, 0]);
        process.stdout.write(JSON.stringify({ type: 'audio', id: request.id, sampleRate: 24000, voice: request.voice, pcmBase64: Buffer.from(pcm.buffer).toString('base64') }) + '\\n');
      });
    `, 'utf8')
    const provider = new MossTtsProvider(root, { executable: process.execPath, sidecar, startupTimeoutMs: 2_000, requestTimeoutMs: 2_000 })
    await provider.prepare()
    expect(provider.state).toBe('ready')
    expect(provider.voices).toEqual(['Junhao'])
    const chunks = []
    for await (const chunk of provider.synthesize({ requestId: 'moss-test', text: '你好', voiceId: 'moss:Junhao', speed: 1 })) chunks.push(chunk)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ sampleRate: 24_000, final: true, sequence: 0 })
    expect(Array.from(chunks[0]!.pcm ?? [])).toEqual([0, 0.25, -0.25, 0])
    await provider.dispose()
  })
})
