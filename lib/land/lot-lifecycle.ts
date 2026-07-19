export const LOT_STATUSES = [
  "controlled",
  "owned",
  "developed",
  "assigned",
  "started",
  "closed",
] as const

export type LotStatus = (typeof LOT_STATUSES)[number]

export const LOT_STATUS_META: Record<LotStatus, { label: string; barClass: string }> = {
  controlled: { label: "Controlled", barClass: "bg-muted-foreground/25" },
  owned: { label: "Owned", barClass: "bg-muted-foreground/50" },
  developed: { label: "Developed", barClass: "bg-chart-3" },
  assigned: { label: "Assigned", barClass: "bg-chart-2" },
  started: { label: "Started", barClass: "bg-chart-1" },
  closed: { label: "Closed", barClass: "bg-chart-4" },
}

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
