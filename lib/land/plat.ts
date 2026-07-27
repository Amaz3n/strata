/**
 * Plat layout.
 *
 * A community's plat is a grid. Lots that somebody has arranged carry their own
 * coordinates and always win — that arrangement is the recorded plat, and
 * nothing here is allowed to move it. Lots that have never been arranged (a
 * fresh import, a range added this morning) are laid out beneath it, grouped by
 * phase, so a community is readable before anyone has touched it.
 *
 * Pure geometry — no data access — so the server and the board agree on where
 * every lot sits.
 */

export const DEFAULT_PLAT_COLUMNS = 12
/** A blank row between the arranged plat and lots that have never been placed. */
const GUTTER_ROWS = 1

export interface PlatLotInput {
  id: string
  lotNumber: string
  block: string | null
  phaseId: string | null
  platX: number | null
  platY: number | null
}

export interface PlatPosition {
  x: number
  y: number
}

export interface PlatLayout {
  positions: Map<string, PlatPosition>
  columns: number
  rows: number
  /** Lots placed by auto-layout because they carry no stored coordinates. */
  unarranged: number
}

function cellKey(x: number, y: number) {
  return `${x},${y}`
}

function hasStoredPosition(lot: PlatLotInput): boolean {
  return (
    lot.platX != null &&
    lot.platY != null &&
    Number.isFinite(lot.platX) &&
    Number.isFinite(lot.platY) &&
    lot.platX >= 0 &&
    lot.platY >= 0
  )
}

/** "Lot 10" sorts after "Lot 9", and blocks sort before lots with no block. */
export function compareLots(a: PlatLotInput, b: PlatLotInput): number {
  const blockA = a.block ?? ""
  const blockB = b.block ?? ""
  if (blockA !== blockB) {
    if (blockA === "") return 1
    if (blockB === "") return -1
    return blockA.localeCompare(blockB, undefined, { numeric: true })
  }
  return a.lotNumber.localeCompare(b.lotNumber, undefined, { numeric: true })
}

export function resolvePlatLayout(
  lots: PlatLotInput[],
  { columns = DEFAULT_PLAT_COLUMNS }: { columns?: number } = {},
): PlatLayout {
  const width = Math.max(1, Math.floor(columns))
  const positions = new Map<string, PlatPosition>()
  const occupied = new Set<string>()
  let maxX = 0
  let maxStoredY = -1

  for (const lot of lots) {
    if (!hasStoredPosition(lot)) continue
    const x = Math.floor(lot.platX as number)
    const y = Math.floor(lot.platY as number)
    // Two lots stored on the same cell is a data accident, not a layout
    // decision; the second one falls through to auto-layout rather than
    // silently hiding under the first.
    if (occupied.has(cellKey(x, y))) continue
    occupied.add(cellKey(x, y))
    positions.set(lot.id, { x, y })
    maxX = Math.max(maxX, x)
    maxStoredY = Math.max(maxStoredY, y)
  }

  const pending = lots.filter((lot) => !positions.has(lot.id))
  let cursorY = maxStoredY >= 0 ? maxStoredY + 1 + GUTTER_ROWS : 0

  if (pending.length > 0) {
    // Phases keep the order they appear in, so an auto-laid plat reads in the
    // same order as the phase list beside it.
    const groups = new Map<string, PlatLotInput[]>()
    for (const lot of pending) {
      const key = lot.phaseId ?? ""
      const group = groups.get(key) ?? []
      group.push(lot)
      groups.set(key, group)
    }

    for (const group of groups.values()) {
      let cursorX = 0
      for (const lot of [...group].sort(compareLots)) {
        while (occupied.has(cellKey(cursorX, cursorY))) {
          cursorX += 1
          if (cursorX >= width) {
            cursorX = 0
            cursorY += 1
          }
        }
        occupied.add(cellKey(cursorX, cursorY))
        positions.set(lot.id, { x: cursorX, y: cursorY })
        maxX = Math.max(maxX, cursorX)
        cursorX += 1
        if (cursorX >= width) {
          cursorX = 0
          cursorY += 1
        }
      }
      // Each phase starts on its own row.
      cursorY += cursorX === 0 ? 0 : 1
    }
  }

  let rows = 0
  for (const position of positions.values()) rows = Math.max(rows, position.y + 1)

  return {
    positions,
    columns: Math.max(width, maxX + 1),
    rows,
    unarranged: pending.length,
  }
}
