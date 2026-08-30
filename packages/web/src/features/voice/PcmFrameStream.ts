export interface PcmFrame {
  sequence: number
  sampleRate: number
  pcm: Float32Array
  final: boolean
}

export async function* readPcmFrames(stream: ReadableStream<Uint8Array>): AsyncIterable<PcmFrame> {
  const reader = stream.getReader()
  let pending = new Uint8Array(0)
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    const combined = new Uint8Array(pending.length + result.value.length)
    combined.set(pending)
    combined.set(result.value, pending.length)
    pending = combined
    while (pending.length >= 20) {
      const header = new DataView(pending.buffer, pending.byteOffset, 20)
      if (String.fromCharCode(...pending.subarray(0, 4)) !== 'DSHV') throw new Error('本地语音流格式无效')
      const sampleCount = header.getUint32(12, true)
      const frameBytes = 20 + sampleCount * 4
      if (pending.length < frameBytes) break
      const payload = new DataView(pending.buffer, pending.byteOffset + 20, sampleCount * 4)
      const pcm = new Float32Array(sampleCount)
      for (let index = 0; index < sampleCount; index += 1) pcm[index] = payload.getFloat32(index * 4, true)
      yield {
        sequence: header.getUint32(4, true),
        sampleRate: header.getUint32(8, true),
        pcm,
        final: (header.getUint32(16, true) & 1) === 1,
      }
      pending = pending.slice(frameBytes)
    }
  }
  if (pending.length !== 0) throw new Error('本地语音流提前结束')
}
