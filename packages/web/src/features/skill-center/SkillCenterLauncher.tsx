import { lazy, Suspense, useState } from 'react'
import { PuzzlePiece } from '@phosphor-icons/react'
import type { EmployeeInstance, World } from '@dsh-cyber/contracts'

const SkillCenterDialog = lazy(async () => ({ default: (await import('./SkillCenterDialog.js')).SkillCenterDialog }))

export function SkillCenterLauncher({ world, employees, onClosed, onOpenMarket }: { world: World; employees: EmployeeInstance[]; onClosed?(): void; onOpenMarket?(): void }) {
  const [open, setOpen] = useState(false)
  const close = (): void => { setOpen(false); onClosed?.() }
  return <>
    <button type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}><PuzzlePiece size={16} />技能中心</button>
    {open ? <Suspense fallback={null}><SkillCenterDialog world={world} employees={employees} onClose={close} {...(onOpenMarket === undefined ? {} : { onOpenMarket })} /></Suspense> : null}
  </>
}
