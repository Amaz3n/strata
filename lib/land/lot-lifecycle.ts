export const LOT_STATUSES = [
  "controlled",
  "owned",
  "developed",
  "assigned",
  "started",
  "closed",
] as const

export type LotStatus = (typeof LOT_STATUSES)[number]

const STATUS_INDEX = new Map<LotStatus, number>(LOT_STATUSES.map((status, index) => [status, index]))

export function assertLotStatusTransition({
  from,
  to,
  hasProject,
  force = false,
}: {
  from: LotStatus
  to: LotStatus
  hasProject: boolean
  force?: boolean
}) {
  if (from === to) return
  if (to === "started" && !hasProject) {
    throw new Error("A project must be attached before a lot can be marked started.")
  }
  if ((from === "started" || from === "closed") && !force) {
    throw new Error(`Moving a lot out of ${from} requires an explicit force confirmation.`)
  }

  const fromIndex = STATUS_INDEX.get(from)
  const toIndex = STATUS_INDEX.get(to)
  if (fromIndex === undefined || toIndex === undefined) {
    throw new Error("Invalid lot status transition.")
  }

  if (toIndex < fromIndex - 1 && !force) {
    throw new Error("Backward lot status corrections may move only one step unless force is confirmed.")
  }
}
