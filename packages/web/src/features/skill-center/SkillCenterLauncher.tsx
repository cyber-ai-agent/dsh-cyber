import { lazy, Suspense, useState } from 'react'
import { PuzzlePiece } from '@phosphor-icons/react'
import type { World } from '@dsh-cyber/contracts'

const SkillCenterDialog = lazy(async () => ({ default: (await import('./SkillCenterDialog.js')).SkillCenterDialog }))

export function SkillCenterLauncher({ world, worlds, onClosed, onOpenMarket }: { world: World; worlds: World[]; onClosed?(): void; onOpenMarket?(): void }) {
  const [open, setOpen] = useState(false)
  const close = (): void => { setOpen(false); onClosed?.() }
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}><PuzzlePiece size={16} />技能中心</button>
    {open ? <Suspense fallback={null}><SkillCenterDialog world={world} worlds={worlds} onClose={close} {...(onOpenMarket === undefined ? {} : { onOpenMarket })} /></Suspense> : null}
  </>
}
