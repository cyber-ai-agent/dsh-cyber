import { ArrowsClockwise, Desktop, Info, Plus, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import type { EnvironmentProfile } from '@dsh-cyber/contracts'

import { useI18n } from '../../i18n/runtime.js'
import {
  addCustomTool,
  loadDeviceProfile,
  loadLocalProfile,
  refreshDeviceProfile,
  refreshLocalProfile,
  removeCustomTool,
  type DeviceEnvironmentScope,
} from './api.js'

/**
 * The machine profile block.
 *
 * It owns its own loading, refresh and editing state on purpose: the profile
 * is host state, not part of any dialog's draft, so closing a settings dialog
 * without saving must never discard or alter it. Every control here is a real
 * button with a visible label; nothing is hidden behind a mirror element.
 *
 * Without a `scope` it describes the host machine; with one it describes that
 * connected device, where the owner-declared tool list is hidden because a
 * device profile is probed over SSH, never edited locally.
 */
export function MachineProfilePanel({ className, scope }: { className?: string; scope?: DeviceEnvironmentScope } = {}) {
  const { t } = useI18n()
  const [profile, setProfile] = useState<EnvironmentProfile | undefined>()
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [draft, setDraft] = useState('')

  const load = useCallback(
    async () => scope === undefined ? loadLocalProfile() : loadDeviceProfile(scope),
    [scope],
  )
  const refresh = useCallback(
    async () => scope === undefined ? refreshLocalProfile('full') : refreshDeviceProfile(scope, 'full'),
    [scope],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const loadedProfile = await load()
        if (!cancelled) setProfile(loadedProfile)
      } catch {
        if (!cancelled) setError(t('machineProfile.error', '机器档案读取失败'))
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [load, t])

  const run = useCallback(async (action: () => Promise<EnvironmentProfile>) => {
    setBusy(true)
    setError(undefined)
    try {
      setProfile(await action())
    } catch {
      setError(t('machineProfile.failed', '操作失败，请稍后重试'))
    } finally {
      setBusy(false)
    }
  }, [t])

  const tools = Object.entries(profile?.tools ?? {})
  const installed = tools.filter(([, tool]) => tool.present)
  const missing = tools.filter(([, tool]) => !tool.present)
  const custom = tools.filter(([, tool]) => tool.source === 'custom')
  const systemLine = profile === undefined ? undefined : `${osLabel(profile.os)} ${profile.arch} · shell: ${profile.shell}`

  return (
    <section className={className === undefined ? 'machine-profile' : `machine-profile ${className}`} aria-labelledby="machine-profile-title">
      <header className="machine-profile__header">
        <span className="machine-profile__icon"><Desktop size={17} aria-hidden="true" /></span>
        <div>
          <h4 id="machine-profile-title">{t('machineProfile.title', '机器档案')}</h4>
          <small>{t('machineProfile.subtitle', '宿主探测的本机事实：操作系统、shell 与可用的命令行工具')}</small>
        </div>
      </header>

      <div className="machine-profile__body">
        {!loaded ? <p className="machine-profile__hint">{t('machineProfile.loading', '正在读取机器档案…')}</p> : null}

        {loaded && profile === undefined ? (
          <div className="machine-profile__summary">
            <p className="machine-profile__hint">{t('machineProfile.empty', '还没有生成机器档案，点“刷新档案”让宿主探测一次。')}</p>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(refresh) }}>
              <ArrowsClockwise size={15} aria-hidden="true" />
              {busy ? t('machineProfile.refreshing', '正在探测…') : t('machineProfile.refresh', '刷新档案')}
            </button>
          </div>
        ) : null}

        {profile !== undefined ? (
          <>
            <div className="machine-profile__summary">
              <code>{systemLine}</code>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => { void run(refresh) }}>
                <ArrowsClockwise size={15} aria-hidden="true" />
                {busy ? t('machineProfile.refreshing', '正在探测…') : t('machineProfile.refresh', '刷新档案')}
              </button>
            </div>

            <div className="machine-profile__group">
              <span className="machine-profile__label">{t('machineProfile.installed', '已安装')}</span>
              <ul className="machine-profile__tools">
                {installed.length === 0 ? <li className="machine-profile__chip is-missing">{t('machineProfile.noNotes', '暂无记录')}</li> : null}
                {installed.map(([name, tool]) => (
                  <li key={name} className="machine-profile__chip">
                    <code>{name}</code>
                    <span>{tool.version ?? t('machineProfile.noVersion', '未取到版本')}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="machine-profile__group">
              <span className="machine-profile__label">{t('machineProfile.missing', '未安装')}</span>
              <ul className="machine-profile__tools">
                {missing.map(([name]) => <li key={name} className="machine-profile__chip is-missing"><code>{name}</code></li>)}
              </ul>
            </div>

            <div className="machine-profile__group">
              <span className="machine-profile__label">{t('machineProfile.notes', '宿主记录')}</span>
              {profile.notes.length === 0
                ? <p className="machine-profile__hint">{t('machineProfile.noNotes', '暂无记录')}</p>
                : (
                    <ul className="machine-profile__notes">
                      {profile.notes.map((note) => <li key={note.id}>{note.text}</li>)}
                    </ul>
                  )}
            </div>

            {scope === undefined ? (
              <div className="machine-profile__group">
                <span className="machine-profile__label">{t('machineProfile.customTitle', '自定义命令行工具')}</span>
                <p className="machine-profile__hint">{t('machineProfile.customHint', '只填可执行文件名，宿主用固定的参数序列探测版本；名字里不能包含空格或参数。')}</p>
                <form
                  className="machine-profile__add"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const name = draft.trim()
                    if (name === '') return
                    void run(() => addCustomTool(name)).then(() => setDraft(''))
                  }}
                >
                  <label className="machine-profile__field">
                    <span>{t('machineProfile.customPlaceholder', '例如 ffmpeg')}</span>
                    <input
                      type="text"
                      value={draft}
                      maxLength={64}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(event) => setDraft(event.target.value)}
                    />
                  </label>
                  <button type="submit" className="secondary-button" disabled={busy || draft.trim() === ''}>
                    <Plus size={15} aria-hidden="true" />
                    {t('machineProfile.customAdd', '添加')}
                  </button>
                </form>
                {custom.length === 0
                  ? <p className="machine-profile__hint">{t('machineProfile.customEmpty', '还没有自定义工具')}</p>
                  : (
                      <ul className="machine-profile__tools">
                        {custom.map(([name, tool]) => (
                          <li key={name} className="machine-profile__chip is-custom">
                            <code>{name}</code>
                            <span>{tool.version ?? t('machineProfile.noVersion', '未取到版本')}</span>
                            <em>{t('machineProfile.customSource', '自定义')}</em>
                            <button type="button" className="machine-profile__remove" disabled={busy} onClick={() => { void run(() => removeCustomTool(name)) }}>
                              <Trash size={14} aria-hidden="true" />
                              {t('machineProfile.customRemove', '移除')}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
              </div>
            ) : null}

            <p className="machine-profile__scope">
              <Info size={14} aria-hidden="true" />
              <span>{t('machineProfile.scopeNote', '档案在会话开始时固定，会话内不变；期间发生变化时，会以一行系统提示告知角色。')}</span>
            </p>
          </>
        ) : null}

        {error !== undefined ? <p className="machine-profile__error" role="alert">{error}</p> : null}
      </div>
    </section>
  )
}

function osLabel(os: EnvironmentProfile['os']): string {
  if (os === 'windows') return 'Windows'
  if (os === 'macos') return 'macOS'
  return 'Linux'
}
