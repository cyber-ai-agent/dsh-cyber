import { SpeakerHigh, Stop } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { EmployeeProfile, VoiceModelDescriptor } from '@dsh-cyber/contracts'

import { api } from '../../api.js'
import { playKokoroSpeech, playMossSpeech, stopKokoroSpeech } from '../world/avatar/speech/KokoroSpeechAdapter.js'
import { speechTextFromMessage } from '../world/digital-human-motion.js'
import { resolveEmployeeVoiceProfile } from './employee-voice-profile.js'

interface MessageSpeechButtonProps {
  employeeId: string
  employeeName: string
  profile?: EmployeeProfile
  text: string
}

export function MessageSpeechButton({ employeeId, employeeName, profile, text }: MessageSpeechButtonProps) {
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => () => {
    stopKokoroSpeech()
    window.speechSynthesis?.cancel()
  }, [])

  const stop = () => {
    stopKokoroSpeech()
    window.speechSynthesis?.cancel()
    setPlaying(false)
    setBusy(false)
  }

  const play = async () => {
    const spokenText = speechTextFromMessage(text)
    if (spokenText.length === 0) { setError('这条回复没有可播报的文字'); return }
    const voice = resolveEmployeeVoiceProfile(employeeId, profile?.gender, profile?.voiceProfile)
    let effectiveProvider = voice.provider
    if (effectiveProvider === 'auto') {
      try {
        const catalog = await api<{ models: VoiceModelDescriptor[] }>('/api/local-tts/models')
        effectiveProvider = catalog.models.some((model) => model.provider === 'moss' && model.state === 'ready') ? 'moss' : 'kokoro'
      } catch { effectiveProvider = 'kokoro' }
    }
    setError(undefined)
    setBusy(true)
    try {
      if (voice.voiceId.startsWith('system:') && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) {
        const voiceUri = voice.voiceId.slice('system:'.length)
        const systemVoice = window.speechSynthesis.getVoices().find((item) => item.voiceURI === voiceUri && /^zh(?:-|_)/iu.test(item.lang))
        if (systemVoice !== undefined) {
          const utterance = new SpeechSynthesisUtterance(spokenText)
          utterance.voice = systemVoice
          utterance.lang = systemVoice.lang
          utterance.rate = voice.speed
          utterance.pitch = voice.pitch
          utterance.onstart = () => { setBusy(false); setPlaying(true) }
          utterance.onend = () => { setBusy(false); setPlaying(false) }
          utterance.onerror = () => { setBusy(false); setPlaying(false); setError('系统中文声音播放失败') }
          window.speechSynthesis.cancel()
          window.speechSynthesis.speak(utterance)
          return
        }
      }
      if (effectiveProvider === 'moss') {
        try {
          await playMossSpeech({
            text: spokenText,
            voiceId: voice.voiceId.startsWith('moss:') ? voice.voiceId : 'moss:Junhao',
            speed: voice.speed,
            onStatus: () => undefined,
            onStart: () => { setBusy(false); setPlaying(true) },
            onEnd: () => { setBusy(false); setPlaying(false) },
          })
          return
        } catch {
          effectiveProvider = 'kokoro'
        }
      }
      const localVoice = voice.voiceId.startsWith('kokoro:')
        ? voice
        : resolveEmployeeVoiceProfile(employeeId, profile?.gender, { ...voice, provider: 'kokoro', voiceId: '' })
      await playKokoroSpeech({
        text: spokenText,
        voiceId: localVoice.voiceId,
        speed: localVoice.speed,
        onStatus: () => undefined,
        onStart: () => { setBusy(false); setPlaying(true) },
        onEnd: () => { setBusy(false); setPlaying(false) },
      })
    } catch (cause) {
      setBusy(false)
      setPlaying(false)
      setError(cause instanceof Error ? cause.message : '语音播放失败')
    }
  }

  return <span className="message-speech">
    <button type="button" className={`message-speech__button${playing ? ' is-playing' : ''}`} aria-label={playing ? `停止播放${employeeName}的回复` : `播放${employeeName}的回复`} title={playing ? '停止播放' : '播放这条回复'} disabled={busy} onClick={playing ? stop : () => void play()}>{playing ? <Stop size={14} weight="fill" /> : <SpeakerHigh size={15} weight="fill" />}</button>
    {error === undefined ? null : <span className="sr-only" role="status">{error}</span>}
  </span>
}
