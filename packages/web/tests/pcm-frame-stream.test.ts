import { describe, expect, it } from 'vitest'

import { readPcmFrames } from '../src/features/voice/PcmFrameStream.js'

describe('PCM frame stream', () => {
  it('parses chunked audio and an empty final frame', async () => {
    const bytes = concatenate([
      encodeFrame(0, new Float32Array([0.25, -0.5]), false),
      encodeFrame(1, new Float32Array(0), true),
    ])
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7))
        controller.enqueue(bytes.slice(7, 25))
        controller.enqueue(bytes.slice(25))
        controller.close()
      },
    })

    const frames = []
    for await (const frame of readPcmFrames(stream)) frames.push(frame)

    expect(frames.map((frame) => ({ sequence: frame.sequence, final: frame.final, samples: frame.pcm.length }))).toEqual([
      { sequence: 0, final: false, samples: 2 },
      { sequence: 1, final: true, samples: 0 },
    ])
    expect(Array.from(frames[0]!.pcm)).toEqual([0.25, -0.5])
  })

  it('rejects a truncated frame', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encodeFrame(0, new Float32Array([1]), false).slice(0, 21)); controller.close() } })
    await expect(async () => { for await (const _frame of readPcmFrames(stream)) { /* consume */ } }).rejects.toThrow('本地语音流提前结束')
  })
})

function encodeFrame(sequence: number, pcm: Float32Array, final: boolean): Uint8Array {
  const bytes = new Uint8Array(20 + pcm.length * 4)
  bytes.set([68, 83, 72, 86])
  const view = new DataView(bytes.buffer)
  view.setUint32(4, sequence, true)
  view.setUint32(8, 48_000, true)
  view.setUint32(12, pcm.length, true)
  view.setUint32(16, final ? 1 : 0, true)
  for (let index = 0; index < pcm.length; index += 1) view.setFloat32(20 + index * 4, pcm[index]!, true)
  return bytes
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) { output.set(part, offset); offset += part.length }
  return output
}
