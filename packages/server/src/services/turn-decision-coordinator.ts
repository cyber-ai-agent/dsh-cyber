/** Provider-neutral gate shared by external Approval and World Permission. */
export interface TurnDecisionGate {
  hasPending(workTurnId: string): boolean | Promise<boolean>
}

/**
 * Coordinates resumption of one existing WorkTurn. It owns no queue and no
 * worker: SQLite/WorkTurn remains the lifecycle authority, while each gate
 * only reports whether a durable decision is still pending.
 */
export class TurnDecisionCoordinator {
  readonly #gates: TurnDecisionGate[]

  constructor(gates: readonly TurnDecisionGate[] = []) {
    this.#gates = [...gates]
  }

  addGate(gate: TurnDecisionGate): void { this.#gates.push(gate) }

  async hasPending(workTurnId: string): Promise<boolean> {
    for (const gate of this.#gates) {
      if (await gate.hasPending(workTurnId)) return true
    }
    return false
  }

  async continueIfReady<T>(workTurnId: string, resume: () => Promise<T>): Promise<T | undefined> {
    if (await this.hasPending(workTurnId)) return undefined
    return await resume()
  }
}

