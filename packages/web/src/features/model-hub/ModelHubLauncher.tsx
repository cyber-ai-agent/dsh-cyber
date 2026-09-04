import { lazy, Suspense, useState } from 'react'
import { Stack } from '@phosphor-icons/react'

import { useI18n } from '../../i18n/runtime.js'

const ModelHubDialog = lazy(async () => ({ default: (await import('./ModelHubDialog.js')).ModelHubDialog }))

/**
 * Top-bar entry for the model hub, placed beside 设置. The dialog itself —
 * providers, catalog, import, balance and capability probes — is lazy: the
 * hub is heavier than a settings panel and belongs out of the first paint.
 */
export function ModelHubLauncher({ workspaceId }: { workspaceId: string }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}><Stack size={16} />{t('app.modelHub', '模型中心')}</button>
    {open ? <Suspense fallback={null}><ModelHubDialog workspaceId={workspaceId} onClose={() => setOpen(false)} /></Suspense> : null}
  </>
}
