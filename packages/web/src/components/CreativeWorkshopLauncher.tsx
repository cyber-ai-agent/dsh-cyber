import { Sparkle } from '@phosphor-icons/react'
import { lazy, Suspense, useState } from 'react'
import { createPortal } from 'react-dom'

const CreativeWorkshopDialog = lazy(async () => {
  const module = await import('./CreativeWorkshopDialog.js')
  return { default: module.CreativeWorkshopDialog }
})

interface CreativeWorkshopLauncherProps {
  workspaceId: string
  onCreated?(): void
}

/**
 * Global product entry for local creative projects. The heavyweight workshop
 * stays out of the initial bundle and its dialog is portalled outside the topbar
 * so topbar navigation CSS can never leak into workshop controls.
 */
export function CreativeWorkshopLauncher({ workspaceId, onCreated }: CreativeWorkshopLauncherProps) {
  const [open, setOpen] = useState(false)

  const dialog = open ? createPortal(
    <Suspense fallback={null}>
      <CreativeWorkshopDialog
        workspaceId={workspaceId}
        onClose={() => setOpen(false)}
        onCreated={() => {
          setOpen(false)
          onCreated?.()
        }}
      />
    </Suspense>,
    document.body,
  ) : null

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}><Sparkle size={16} />创意工坊</button>
      {dialog}
    </>
  )
}
