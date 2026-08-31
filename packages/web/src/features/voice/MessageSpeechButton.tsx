import { SpeakerHigh, Stop } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import type { EmployeeProfile } from '@dsh-cyber/contracts'

import { speakAsCharacter, stopCharacterSpeech } from './speak-as-character.js'

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

  useEffect(() => () => stopCharacterSpeech(), [])

  const stop = () => {
    stopCharacterSpeech()
    setPlaying(false)
    setBusy(false)
  }

  const play = async () => {
    setError(undefined)
    setBusy(true)
    try {
      await speakAsCharacter({
        employeeId,
        text,
        ...(profile === undefined ? {} : { profile }),
        onStart: () => { setBusy(false); setPlaying(true) },
        onEnd: () => { setBusy(false); setPlaying(false) },
      })
      setBusy(false)
      setPlaying(false)
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
