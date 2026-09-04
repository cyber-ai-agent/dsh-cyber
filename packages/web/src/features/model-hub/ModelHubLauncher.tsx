import { lazy, Suspense, useState } from 'react'
import type { EmployeeInstance, World } from '@dsh-cyber/contracts'
import { Stack } from '@phosphor-icons/react'

import { useI18n } from '../../i18n/runtime.js'

const ModelHubDialog = lazy(async () => ({ default: (await import('./ModelHubDialog.js')).ModelHubDialog }))

/**
 * Top-bar entry for the model hub, placed beside 设置. The dialog itself —
 * providers, catalog, import, balance and capability probes — is lazy: the
 * hub is heavier than a settings panel and belongs out of the first paint.
 * Worlds and employees are passed through for the assignment tab rather than
 * re-fetched: the shell already holds them.
 */
export function ModelHubLauncher({ workspaceId, worlds, employees }: { workspaceId: string; worlds: World[]; employees: EmployeeInstance[] }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}><Stack size={16} />{t('app.modelHub', '模型中心')}</button>
    {open ? <Suspense fallback={null}><ModelHubDialog workspaceId={workspaceId} worlds={worlds} employees={employees} onClose={() => setOpen(false)} /></Suspense> : null}
  </>
}
