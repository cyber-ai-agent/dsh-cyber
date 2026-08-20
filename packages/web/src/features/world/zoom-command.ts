import type { WorldZoomCommand } from '@dsh-cyber/contracts'

let commandSequence = 0

export function createZoomCommand(delta: WorldZoomCommand['delta']): WorldZoomCommand {
  commandSequence += 1
  return { id: `zoom-${Date.now()}-${commandSequence}`, delta }
}
