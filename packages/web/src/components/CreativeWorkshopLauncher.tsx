import { Sparkle } from '@phosphor-icons/react'
import { lazy, Suspense, useState } from 'react'

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
 * stays out of the initial bundle and owns its own open/close lifecycle.
 */
export function CreativeWorkshopLauncher({ workspaceId, onCreated }: CreativeWorkshopLauncherProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}><Sparkle size={16} />创意工坊</button>
      {open ? (
        <Suspense fallback={null}>
          <CreativeWorkshopDialog
            workspaceId={workspaceId}
            onClose={() => setOpen(false)}
            onCreated={() => {
              setOpen(false)
              onCreated?.()
            }}
          />
        </Suspense>
      ) : null}
    </>
  )
}
