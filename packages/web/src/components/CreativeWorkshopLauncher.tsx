import { Sparkle } from '@phosphor-icons/react'
import { lazy, Suspense, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WorkshopProjectView } from '@dsh-cyber/contracts/creative-platform'
import { useI18n } from '../i18n/runtime.js'

const CreativeWorkshopDialog = lazy(async () => {
  const module = await import('./CreativeWorkshopDialog.js')
  return { default: module.CreativeWorkshopDialog }
})

interface CreativeWorkshopLauncherProps {
  workspaceId: string
  onCreated?(project: WorkshopProjectView): void
  onOpenWorld?(worldId: string): void
}

/**
 * Global product entry for local creative projects. The heavyweight workshop
 * stays out of the initial bundle and its dialog is portalled outside the topbar
 * so topbar navigation CSS can never leak into workshop controls.
 */
export function CreativeWorkshopLauncher({ workspaceId, onCreated, onOpenWorld }: CreativeWorkshopLauncherProps) {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()

  const dialog = open ? createPortal(
    <Suspense fallback={null}>
      <CreativeWorkshopDialog
        workspaceId={workspaceId}
        onClose={() => setOpen(false)}
        onCreated={(project) => {
          setOpen(false)
          onCreated?.(project)
        }}
        onOpenWorld={(worldId) => {
          setOpen(false)
          onOpenWorld?.(worldId)
        }}
      />
    </Suspense>,
    document.body,
  ) : null

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}><Sparkle size={16} />{t('app.creativeWorkshop', '创意工坊')}</button>
      {dialog}
    </>
  )
}
