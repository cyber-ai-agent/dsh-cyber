import { lazy, Suspense, useState } from 'react'
import type { Workspace } from '@dsh-cyber/contracts'
import { PlugsConnected } from '@phosphor-icons/react'

import { useI18n } from '../../i18n/runtime.js'

const ConnectionHubDialog = lazy(async () => ({ default: (await import('./ConnectionHubDialog.js')).ConnectionHubDialog }))

/**
 * Top-bar entry for the connection hub, placed right after the model hub. The
 * dialog is lazy: connection management belongs out of the first paint.
 */
export function ConnectionHubLauncher({ workspace, onClosed }: { workspace: Workspace; onClosed?(): void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const close = (): void => { setOpen(false); onClosed?.() }
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}><PlugsConnected size={16} />{t('app.connectionHub', '连接中心')}</button>
    {open ? <Suspense fallback={null}><ConnectionHubDialog workspace={workspace} onClose={close} /></Suspense> : null}
  </>
}
