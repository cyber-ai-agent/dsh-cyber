import { Microphone, StopCircle, Waveform } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { stopKokoroSpeech } from '../world/avatar/speech/KokoroSpeechAdapter.js'
import { currentSpeechAmplitude } from '../world/avatar/speech/speech-playback-state.js'
import { calculateBargeInThreshold, isBargeInFrame, pcmRms, updateEchoBaseline } from './barge-in-threshold.js'
import './voice-conversation-control.css'

type VoiceUiState = 'cold' | 'warming' | 'ready' | 'listening' | 'speech' | 'finalizing' | 'failed'

interface VoiceConversationControlProps {
  employeeName: string
  disabled?: boolean
  variant?: 'focus' | 'compact'
  onFinal(text: string): Promise<void>
  onBargeIn?(): void
}

export function VoiceConversationControl({ employeeName, disabled = false, variant = 'focus', onFinal, onBargeIn }: VoiceConversationControlProps) {
  const [state, setState] = useState<VoiceUiState>('cold')
  const [partial, setPartial] = useState('')
  const [error, setError] = useState<string>()
  const socketRef = useRef<WebSocket | undefined>(undefined)
  const contextRef = useRef<AudioContext | undefined>(undefined)
  const streamRef = useRef<MediaStream | undefined>(undefined)
  const sourceRef = useRef<MediaStreamAudioSourceNode | undefined>(undefined)
  const workletRef = useRef<AudioWorkletNode | undefined>(undefined)
  const ownerIdRef = useRef(crypto.randomUUID())
  const echoBaselineRef = useRef(0)
  const bargeThresholdRef = useRef<number | undefined>(undefined)
  // Every capture gets a generation. Stop/unmount invalidates it synchronously,
  // so a late onFinal()/speech-end from the previous capture cannot put the UI
  // back into `listening` after the user explicitly ended the conversation.
  const captureGenerationRef = useRef(0)
  const captureActiveRef = useRef(false)

  const prepare = useCallback(() => {
    if (disabled || !('WebSocket' in window)) return
    // A previous failure must not outlive the attempt that caused it. The
    // guard used to return before clearing the error, so once anything went
    // wrong the notice stayed on screen for the rest of the session — and in
    // the composer it is an absolutely positioned panel, so it sat over the
    // send button until reload.
    setError(undefined)
    if (socketRef.current !== undefined) return
    setState('warming')
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${location.host}/api/voice/session`)
    socket.binaryType = 'arraybuffer'
    socketRef.current = socket
    socket.onopen = () => socket.send(JSON.stringify({ type: 'prepare' }))
    socket.onmessage = (message) => {
      if (typeof message.data !== 'string') return
      const event = JSON.parse(message.data) as { type: string; text?: string; message?: string }
      if (event.type === 'prepared') setState((current) => current === 'listening' || current === 'speech' || current === 'finalizing' ? current : 'ready')
      else if (event.type === 'listening') setState(captureActiveRef.current ? 'listening' : 'ready')
      else if (event.type === 'speech-start') {
        if (!captureActiveRef.current) return
        stopKokoroSpeech(); window.speechSynthesis?.cancel(); onBargeIn?.(); echoBaselineRef.current = 0; bargeThresholdRef.current = undefined; setState('speech')
      } else if (event.type === 'partial') {
        if (!captureActiveRef.current) return
        setPartial(event.text ?? ''); setState('speech')
      } else if (event.type === 'final' && event.text?.trim()) {
        if (!captureActiveRef.current) return
        const generation = captureGenerationRef.current
        const text = event.text.trim(); setPartial(text); setState('finalizing')
        void onFinal(text).then(() => {
          setPartial('')
          setState(captureActiveRef.current && captureGenerationRef.current === generation ? 'listening' : 'ready')
        }).catch((cause: unknown) => {
          // An explicitly stopped/replaced capture owns no UI any more. Its
          // message promise may still settle, but it must not resurrect a
          // failed/listening state for the next capture.
          if (!captureActiveRef.current || captureGenerationRef.current !== generation) {
            setPartial('')
            setState('ready')
            return
          }
          setError(cause instanceof Error ? cause.message : '语音消息发送失败'); setState('failed')
        })
      } else if (event.type === 'error') {
        if (!captureActiveRef.current) return
        setError(event.message ?? '本地语音识别失败'); setState('failed')
      } else if (event.type === 'speech-end') {
        setState((current) => current === 'finalizing' ? current : captureActiveRef.current ? 'listening' : 'ready')
      } else if (event.type === 'stopped' || event.type === 'cancelled') {
        // Without these the UI kept saying it was listening after the server
        // had stopped, and the only way out was to press the button twice.
        setPartial(''); setState(captureActiveRef.current ? 'listening' : 'ready')
      }
    }
    socket.onerror = () => { setError('无法连接本地语音服务'); setState('failed') }
    socket.onclose = () => {
      socketRef.current = undefined
      captureActiveRef.current = false
      captureGenerationRef.current += 1
      workletRef.current?.disconnect(); sourceRef.current?.disconnect()
      for (const track of streamRef.current?.getTracks() ?? []) track.stop()
      void contextRef.current?.close()
      workletRef.current = undefined; sourceRef.current = undefined; streamRef.current = undefined; contextRef.current = undefined
      echoBaselineRef.current = 0; bargeThresholdRef.current = undefined
      setPartial('')
      setState((current) => current === 'failed' ? current : 'cold')
    }
  }, [disabled, onBargeIn, onFinal])

  const start = useCallback(async () => {
    const generation = captureGenerationRef.current + 1
    captureGenerationRef.current = generation
    window.dispatchEvent(new CustomEvent('dsh:voice-exclusive', { detail: ownerIdRef.current }))
    // A socket left over from a failed attempt cannot be reused: the server
    // has already given up on that session, so retrying through it looks like
    // the retry did nothing.
    if (socketRef.current !== undefined && socketRef.current.readyState > WebSocket.OPEN) {
      socketRef.current = undefined
    }
    prepare()
    const socket = socketRef.current
    if (socket === undefined) return
    if (socket.readyState !== WebSocket.OPEN) await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('本地语音服务连接超时')), 8_000)
      socket.addEventListener('open', () => { window.clearTimeout(timer); resolve() }, { once: true })
    })
    // Another voice control can claim the microphone while this one is still
    // warming. Do not finish opening a superseded generation afterwards.
    if (captureGenerationRef.current !== generation) return
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
    if (captureGenerationRef.current !== generation) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    const context = new AudioContext()
    await context.audioWorklet.addModule('/voice-capture-worklet.js')
    if (captureGenerationRef.current !== generation) {
      for (const track of stream.getTracks()) track.stop()
      await context.close().catch(() => undefined)
      return
    }
    const source = context.createMediaStreamSource(stream)
    const worklet = new AudioWorkletNode(context, 'dsh-voice-capture')
    const muted = context.createGain(); muted.gain.value = 0
    source.connect(worklet); worklet.connect(muted); muted.connect(context.destination)
    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (captureGenerationRef.current !== generation || !captureActiveRef.current || socket.readyState !== WebSocket.OPEN) return
      // While the character is talking, its own voice comes back through the
      // speakers and trips the recogniser, so it interrupts itself and the
      // conversation collapses into a loop. Echo cancellation helps and does
      // not finish the job on external speakers.
      //
      // Half-duplex would kill barge-in, which is the point of a microphone
      // during a reply, so the bar is raised rather than closed: speak louder
      // than the speaker and you get through.
      const playbackAmplitude = currentSpeechAmplitude()
      const frameRms = pcmRms(event.data)
      echoBaselineRef.current = updateEchoBaseline(echoBaselineRef.current, frameRms, playbackAmplitude)
      bargeThresholdRef.current = calculateBargeInThreshold(playbackAmplitude, echoBaselineRef.current, bargeThresholdRef.current)
      if (!isBargeInFrame(event.data, playbackAmplitude, echoBaselineRef.current, bargeThresholdRef.current)) return
      const packet = new ArrayBuffer(8 + event.data.byteLength)
      new DataView(packet).setFloat64(0, performance.now(), true)
      new Uint8Array(packet, 8).set(new Uint8Array(event.data))
      socket.send(packet)
    }
    streamRef.current = stream; contextRef.current = context; sourceRef.current = source; workletRef.current = worklet
    echoBaselineRef.current = 0; bargeThresholdRef.current = undefined
    captureActiveRef.current = true
    socket.send(JSON.stringify({ type: 'start', endpointSilenceMs: 650 }))
    setState('listening'); setError(undefined)
  }, [prepare])

  const stop = useCallback(() => {
    // Invalidate async work before touching transport/resources. A final event
    // may already have called onFinal(); its promise is allowed to finish the
    // message send, but no longer owns this control's state.
    captureActiveRef.current = false
    captureGenerationRef.current += 1
    socketRef.current?.send(JSON.stringify({ type: 'stop' }))
    workletRef.current?.disconnect(); sourceRef.current?.disconnect()
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    void contextRef.current?.close()
    workletRef.current = undefined; sourceRef.current = undefined; streamRef.current = undefined; contextRef.current = undefined
    echoBaselineRef.current = 0; bargeThresholdRef.current = undefined
    setPartial(''); setError(undefined); setState('ready')
  }, [])

  useEffect(() => () => {
    captureActiveRef.current = false
    captureGenerationRef.current += 1
    workletRef.current?.disconnect(); sourceRef.current?.disconnect()
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    void contextRef.current?.close(); socketRef.current?.close()
  }, [])

  useEffect(() => {
    const releaseOtherCapture = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== ownerIdRef.current && (streamRef.current !== undefined || contextRef.current !== undefined)) stop()
    }
    window.addEventListener('dsh:voice-exclusive', releaseOtherCapture)
    return () => window.removeEventListener('dsh:voice-exclusive', releaseOtherCapture)
  }, [stop])

  const active = state === 'listening' || state === 'speech' || state === 'finalizing'
  const startSafely = () => void start().catch((cause: unknown) => {
    captureActiveRef.current = false
    captureGenerationRef.current += 1
    setError(cause instanceof Error ? cause.message : '无法启动语音对话'); setState('failed')
  })
  return <div className={`voice-conversation voice-conversation--${variant} is-${state}`} onMouseEnter={prepare}>
    <button type="button" className="voice-conversation__button" disabled={disabled || state === 'warming'} aria-label={active ? '结束语音对话' : '开始语音对话'} onClick={active ? stop : startSafely}>
      {active ? <StopCircle size={20} weight="fill" /> : <Microphone size={20} weight="fill" />}
    </button>
    {variant === 'compact' && !active && error === undefined ? null : <span className="voice-conversation__content">
      <strong>{voiceLabel(state, employeeName)}</strong>
      <small>{partial || error || (state === 'ready' ? '点击后直接说话，停顿后自动发送' : '本地处理 · 不保存音频')}</small>
    </span>}
    {state === 'speech' ? <Waveform className="voice-conversation__wave" size={28} aria-hidden="true" /> : null}
  </div>
}

function voiceLabel(state: VoiceUiState, employeeName: string): string {
  if (state === 'warming') return '正在准备本地语音'
  if (state === 'listening') return '正在听…'
  if (state === 'speech') return '正在听你说话'
  if (state === 'finalizing') return `${employeeName} 正在理解…`
  if (state === 'failed') return '语音暂时不可用'
  return '语音对话'
}
