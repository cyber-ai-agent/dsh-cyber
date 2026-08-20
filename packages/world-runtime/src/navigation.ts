import type { WorldPoint, WorldThemeNavigationManifest } from '@dsh-cyber/contracts'

interface Cell {
  column: number
  row: number
}

const DIRECTIONS: readonly Cell[] = [
  { column: 0, row: -1 },
  { column: 1, row: 0 },
  { column: 0, row: 1 },
  { column: -1, row: 0 },
]

export function findPath(
  navigation: WorldThemeNavigationManifest,
  start: WorldPoint,
  goal: WorldPoint,
): WorldPoint[] {
  const startCell = pointToCell(navigation, start)
  const goalCell = pointToCell(navigation, goal)
  const startKey = cellKey(startCell)
  const goalKey = cellKey(goalCell)
  if (startKey === goalKey) return [goal]

  const blocked = new Set(navigation.blocked)
  blocked.delete(startKey)
  blocked.delete(goalKey)
  const open = new Map<string, { cell: Cell; score: number; order: number }>()
  const cameFrom = new Map<string, string>()
  const cells = new Map<string, Cell>([[startKey, startCell]])
  const gScore = new Map<string, number>([[startKey, 0]])
  let order = 0
  open.set(startKey, { cell: startCell, score: manhattan(startCell, goalCell), order: order++ })

  while (open.size > 0) {
    const currentEntry = [...open.entries()].sort((left, right) => {
      const scoreDelta = left[1].score - right[1].score
      return scoreDelta !== 0 ? scoreDelta : left[1].order - right[1].order
    })[0]
    if (currentEntry === undefined) break
    const [currentKey, current] = currentEntry
    open.delete(currentKey)
    if (currentKey === goalKey) {
      const route = reconstruct(cameFrom, cells, currentKey)
      return route.map((cell, index) =>
        index === route.length - 1 ? goal : cellToPoint(navigation, cell),
      )
    }

    for (const direction of DIRECTIONS) {
      const neighbor: Cell = {
        column: current.cell.column + direction.column,
        row: current.cell.row + direction.row,
      }
      if (!inside(navigation, neighbor)) continue
      const neighborKey = cellKey(neighbor)
      if (blocked.has(neighborKey)) continue
      const tentative = (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + 1
      if (tentative >= (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) continue
      cameFrom.set(neighborKey, currentKey)
      cells.set(neighborKey, neighbor)
      gScore.set(neighborKey, tentative)
      open.set(neighborKey, {
        cell: neighbor,
        score: tentative + manhattan(neighbor, goalCell),
        order: order++,
      })
    }
  }
  return []
}

export function cellKey(cell: Cell): string {
  return `${cell.column},${cell.row}`
}

function pointToCell(navigation: WorldThemeNavigationManifest, point: WorldPoint): Cell {
  return {
    column: clamp(Math.floor((point.x - navigation.origin.x) / navigation.cellSize), 0, navigation.columns - 1),
    row: clamp(Math.floor((point.y - navigation.origin.y) / navigation.cellSize), 0, navigation.rows - 1),
  }
}

function cellToPoint(navigation: WorldThemeNavigationManifest, cell: Cell): WorldPoint {
  return {
    x: navigation.origin.x + (cell.column + 0.5) * navigation.cellSize,
    y: navigation.origin.y + (cell.row + 0.5) * navigation.cellSize,
  }
}

function inside(navigation: WorldThemeNavigationManifest, cell: Cell): boolean {
  return cell.column >= 0
    && cell.row >= 0
    && cell.column < navigation.columns
    && cell.row < navigation.rows
}

function manhattan(left: Cell, right: Cell): number {
  return Math.abs(left.column - right.column) + Math.abs(left.row - right.row)
}

function reconstruct(cameFrom: Map<string, string>, cells: Map<string, Cell>, end: string): Cell[] {
  const path: Cell[] = []
  let current: string | undefined = end
  while (current !== undefined) {
    const cell = cells.get(current)
    if (cell !== undefined) path.push(cell)
    current = cameFrom.get(current)
  }
  return path.reverse()
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
