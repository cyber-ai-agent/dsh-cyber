class DshVoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.source = []
    this.position = 0
    this.frame = []
    this.ratio = sampleRate / 16000
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    for (const sample of channel) this.source.push(sample)
    while (this.position + 1 < this.source.length) {
      const left = Math.floor(this.position)
      const mix = this.position - left
      const value = this.source[left] * (1 - mix) + this.source[left + 1] * mix
      this.frame.push(Math.max(-1, Math.min(1, value)))
      this.position += this.ratio
      if (this.frame.length === 320) {
        const pcm = new Int16Array(320)
        for (let index = 0; index < pcm.length; index += 1) pcm[index] = Math.round(this.frame[index] * (this.frame[index] < 0 ? 32768 : 32767))
        this.port.postMessage(pcm.buffer, [pcm.buffer])
        this.frame = []
      }
    }
    const consumed = Math.floor(this.position)
    if (consumed > 0) { this.source.splice(0, consumed); this.position -= consumed }
    return true
  }
}

registerProcessor('dsh-voice-capture', DshVoiceCaptureProcessor)
