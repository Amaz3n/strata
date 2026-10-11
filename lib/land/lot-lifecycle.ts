import { z } from "zod"

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

/**
 * Statuses a land manager may set by hand. Everything past `developed` is the
 * consequence of an owning event — a hold on the Sales desk, a release from
 * Starts, a settlement at closing — so the community workbench reads those but
 * never sets them.
 */
export const LAND_SETTABLE_LOT_STATUSES = ["controlled", "owned", "developed"] as const

/**
 * The key lots with no phase are grouped under. Shared by the phase counts and
 * the Land tab that renders them, so the client never imports the service.
 */
export const UNPHASED_KEY = "unphased"

export function isLotStatus(value: string | undefined | null): value is LotStatus {
  return value != null && (LOT_STATUSES as readonly string[]).includes(value)
}

/**
 * Where a lot lands when its home is linked or unlinked. Attaching a home is
 * what makes a lot a house under construction; taking it away puts the lot back
 * in inventory.
 */
export const ATTACHED_LOT_STATUS: LotStatus = "started"
export const DETACHED_LOT_STATUS: LotStatus = "assigned"

/** States a lot only holds while no home stands on it. */
const HOMELESS_LOT_STATUSES: readonly LotStatus[] = ["controlled", "owned", "developed"]

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
  if (to === "closed" && !hasProject) {
    throw new Error("A lot cannot be closed without a home; attach the home that settled first.")
  }
  if (hasProject && HOMELESS_LOT_STATUSES.includes(to)) {
    throw new Error(`A lot with a home attached cannot be set to ${to}; detach the home first.`)
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

/**
 * Linking a home to a lot is a status change like any other, so it answers to
 * the same machine. Without this, attaching a project to a settled lot silently
 * reversed the closing — the one move `setLotStatus` has always required an
 * explicit confirmation for.
 */
export function assertLotAttachTransition({ from, force = false }: { from: LotStatus; force?: boolean }) {
  assertLotStatusTransition({ from, to: ATTACHED_LOT_STATUS, hasProject: true, force })
}

/**
 * Unlinking is the backward half. A house that is building or has settled cannot
 * quietly drop back into inventory; that is what `force` is for.
 */
export function assertLotDetachTransition({ from, force = false }: { from: LotStatus; force?: boolean }) {
  assertLotStatusTransition({ from, to: DETACHED_LOT_STATUS, hasProject: false, force })
}

/**
 * Sales state is not land delivery. A hold on an owned lot advances it to
 * `assigned` the moment a buyer is attached, but the dirt is still undeveloped.
 * `lots.delivered_at` is the land fact (the database stamps it when a lot is
 * developed), and a vertical start needs it — or a recorded exception, which is
 * the only way a house starts on a lot that has not been delivered.
 */
export const MIN_DELIVERY_EXCEPTION_REASON_LENGTH = 10

const deliveryExceptionSchema = z.object({
  reason: z.string().trim().min(MIN_DELIVERY_EXCEPTION_REASON_LENGTH),
  by: z.string().uuid(),
  at: z.string(),
})
export type LotDeliveryException = z.infer<typeof deliveryExceptionSchema>

export function lotDeliveryException(metadata: unknown): LotDeliveryException | null {
  const parsed = z.object({ delivery_exception: deliveryExceptionSchema }).safeParse(metadata)
  return parsed.success ? parsed.data.delivery_exception : null
}

export const LOT_DELIVERY_REFUSAL =
  "This lot has not been delivered by land development. Record a delivery exception with a reason to build on it."

/** Why a lot cannot take a house yet because its land is undelivered, or null when it can. */
export function lotDeliveryRefusal(lot: { deliveredAt: string | null; metadata: unknown }): string | null {
  if (lot.deliveredAt || lotDeliveryException(lot.metadata)) return null
  return LOT_DELIVERY_REFUSAL
}

/** Why a lot cannot take a vertical start, or null when it can. */
export function verticalStartRefusal(lot: {
  status: string
  deliveredAt: string | null
  metadata: unknown
}): string | null {
  if (!["developed", "assigned"].includes(lot.status)) {
    return "Only developed or assigned lots can enter the start pipeline."
  }
  return lotDeliveryRefusal(lot)
}
