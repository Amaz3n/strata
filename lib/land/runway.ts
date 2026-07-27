/**
 * The lot supply runway: sellable inventory walked forward in time, draining at
 * the rate lots are consumed and stepping up at each scheduled takedown. The
 * moment the curve touches zero is the day a community can no longer sell
 * anything, which is the question the communities desk exists to answer.
 *
 * Pure geometry — no data access — so both the server projection and the board
 * that draws it read from one definition.
 */

/** Running out inside two quarters is an emergency; later than that is a plan. */
export const DRY_ALERT_MONTHS = 6

export type CommunityLifecycleStatus = "planning" | "active" | "sold_out" | "closed"

/**
 * What the curve says about a community, in the order a land manager triages:
 * it is dying, frozen, thin, not open yet, finishing, or fine.
 */
export type RunwayVerdict = "dry" | "stalled" | "tight" | "opening" | "closing" | "holds"

/** `t` is fractional months from today; `lots` is sellable lots at that moment. */
export interface RunwayPoint {
  t: number
  lots: number
}

export interface RunwayDelivery {
  /** Fractional months from today — the x position of the step. */
  monthOffset: number
  lotCount: number
}

export function buildRunway(
  sellableLots: number,
  consumptionPerMonth: number | null,
  deliveries: RunwayDelivery[],
  horizonMonths: number,
): { runway: RunwayPoint[]; dryAtMonth: number | null } {
  const rate = consumptionPerMonth != null && consumptionPerMonth > 0 ? consumptionPerMonth : 0
  const runway: RunwayPoint[] = [{ t: 0, lots: sellableLots }]
  let lots = sellableLots
  let at = 0
  let dryAtMonth: number | null = null

  const drainTo = (target: number) => {
    if (target <= at) return
    if (lots <= 0) {
      runway.push({ t: target, lots: 0 })
      at = target
      return
    }
    const emptyAt = rate > 0 ? at + lots / rate : Number.POSITIVE_INFINITY
    if (emptyAt < target) {
      runway.push({ t: emptyAt, lots: 0 })
      dryAtMonth = dryAtMonth ?? emptyAt
      runway.push({ t: target, lots: 0 })
      lots = 0
    } else {
      lots = Math.max(0, lots - rate * (target - at))
      runway.push({ t: target, lots })
    }
    at = target
  }

  for (const delivery of [...deliveries].sort((a, b) => a.monthOffset - b.monthOffset)) {
    if (delivery.monthOffset > horizonMonths) break
    drainTo(delivery.monthOffset)
    lots += delivery.lotCount
    runway.push({ t: delivery.monthOffset, lots })
  }
  drainTo(horizonMonths)

  return { runway, dryAtMonth }
}

/** Sellable lots at an arbitrary point on the curve, for the board's scrubber. */
export function lotsAt(runway: RunwayPoint[], t: number): number {
  if (runway.length === 0) return 0
  if (t <= runway[0].t) return runway[0].lots
  for (let index = 1; index < runway.length; index += 1) {
    const from = runway[index - 1]
    const to = runway[index]
    if (t > to.t) continue
    if (to.t === from.t) return to.lots
    return from.lots + (to.lots - from.lots) * ((t - from.t) / (to.t - from.t))
  }
  return runway[runway.length - 1].lots
}

export function runwayVerdict({
  status,
  sellableLots,
  deliveryCount,
  consumptionPerMonth,
  dryAtMonth,
}: {
  status: CommunityLifecycleStatus
  sellableLots: number
  deliveryCount: number
  consumptionPerMonth: number | null
  dryAtMonth: number | null
}): RunwayVerdict {
  if (status === "sold_out" || status === "closed") return "closing"
  if (sellableLots === 0 && deliveryCount > 0) return "opening"
  if (status === "planning") return "opening"
  if (consumptionPerMonth == null || consumptionPerMonth <= 0) return "stalled"
  if (dryAtMonth == null) return "holds"
  return dryAtMonth <= DRY_ALERT_MONTHS ? "dry" : "tight"
}
