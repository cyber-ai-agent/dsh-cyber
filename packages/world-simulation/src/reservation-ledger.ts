import type {
  WorldSlotDefinition,
  WorldSlotReservation,
} from '@dsh-cyber/contracts/world-simulation'

export interface ReserveWorldSlotsInput {
  reservationIdPrefix: string
  worldId: string
  characterIds: string[]
  slots: WorldSlotDefinition[]
  planId: string
  priority: number
  now: string
  expiresAt: string
}

export interface ReserveWorldSlotsResult {
  accepted: boolean
  reservations: WorldSlotReservation[]
  reason?: 'insufficient-slots' | 'slot-conflict' | 'invalid-input'
}

export class WorldSlotReservationLedger {
  readonly #reservations = new Map<string, WorldSlotReservation>()

  constructor(initial: readonly WorldSlotReservation[] = []) {
    for (const reservation of initial) this.#reservations.set(reservation.id, { ...reservation })
  }

  list(worldId?: string): WorldSlotReservation[] {
    return [...this.#reservations.values()]
      .filter((reservation) => worldId === undefined || reservation.worldId === worldId)
      .sort((left, right) => left.slotId.localeCompare(right.slotId) || left.characterId.localeCompare(right.characterId))
      .map((reservation) => ({ ...reservation }))
  }

  reserve(input: ReserveWorldSlotsInput): ReserveWorldSlotsResult {
    if (input.characterIds.length === 0 || input.characterIds.length !== input.slots.length) {
      return { accepted: false, reservations: [], reason: 'invalid-input' }
    }
    const uniqueCharacters = new Set(input.characterIds)
    const uniqueSlots = new Set(input.slots.map((slot) => slot.id))
    if (uniqueCharacters.size !== input.characterIds.length || uniqueSlots.size !== input.slots.length) {
      return { accepted: false, reservations: [], reason: 'invalid-input' }
    }

    this.releaseExpired(input.now)
    const conflicts = input.slots.filter((slot) => slot.exclusive && this.slotOccupied(input.worldId, slot.id))
    if (conflicts.length > 0) return { accepted: false, reservations: [], reason: 'slot-conflict' }

    const reservations = input.characterIds.map((characterId, index): WorldSlotReservation => {
      const slot = input.slots[index]!
      return {
        id: `${input.reservationIdPrefix}:${index + 1}`,
        worldId: input.worldId,
        slotId: slot.id,
        characterId,
        planId: input.planId,
        status: 'reserved',
        priority: input.priority,
        reservedAt: input.now,
        expiresAt: input.expiresAt,
        updatedAt: input.now,
      }
    })
    for (const reservation of reservations) this.#reservations.set(reservation.id, reservation)
    return { accepted: true, reservations: reservations.map((reservation) => ({ ...reservation })) }
  }

  occupy(reservationId: string, now: string): WorldSlotReservation {
    const reservation = this.#reservations.get(reservationId)
    if (reservation === undefined) throw new Error(`Slot reservation not found: ${reservationId}`)
    const occupied = { ...reservation, status: 'occupied' as const, updatedAt: now }
    this.#reservations.set(reservationId, occupied)
    return { ...occupied }
  }

  releasePlan(planId: string): WorldSlotReservation[] {
    const released: WorldSlotReservation[] = []
    for (const [id, reservation] of this.#reservations) {
      if (reservation.planId !== planId) continue
      released.push({ ...reservation })
      this.#reservations.delete(id)
    }
    return released
  }

  releaseCharacter(characterId: string): WorldSlotReservation[] {
    const released: WorldSlotReservation[] = []
    for (const [id, reservation] of this.#reservations) {
      if (reservation.characterId !== characterId) continue
      released.push({ ...reservation })
      this.#reservations.delete(id)
    }
    return released
  }

  releaseExpired(now: string): WorldSlotReservation[] {
    const released: WorldSlotReservation[] = []
    const timestamp = Date.parse(now)
    for (const [id, reservation] of this.#reservations) {
      if (Date.parse(reservation.expiresAt) > timestamp) continue
      released.push({ ...reservation })
      this.#reservations.delete(id)
    }
    return released
  }

  occupiedSlotIds(worldId: string): Set<string> {
    return new Set(this.list(worldId).map((reservation) => reservation.slotId))
  }

  private slotOccupied(worldId: string, slotId: string): boolean {
    return [...this.#reservations.values()].some((reservation) =>
      reservation.worldId === worldId && reservation.slotId === slotId)
  }
}
