import { z } from "zod"

/**
 * Is this plan, in this elevation, on the community's price sheet today?
 *
 * One answer for every gate that puts a plan on a lot: instantiation, and the
 * start package's plan gate (which release re-derives). A row with no elevation
 * offers every elevation of the plan; a row with one offers only that one.
 * Withdrawn rows and rows outside their effective dates offer nothing — a lot
 * pinned to a plan the community has since withdrawn is no longer buildable
 * there unless a person with plan-release authority said so, on the record.
 */
export type PlanOfferingRow = {
  is_available: boolean
  elevation_id: string | null
  effective_start: string | null
  effective_end: string | null
}

function offeredRows<Row extends PlanOfferingRow>(rows: readonly Row[], input: { elevationId: string | null; onDate: string }): Row[] {
  return rows.filter(
    (row) =>
      row.is_available &&
      (row.elevation_id === null || row.elevation_id === input.elevationId) &&
      (!row.effective_start || row.effective_start <= input.onDate) &&
      (!row.effective_end || row.effective_end >= input.onDate),
  )
}

export function isPlanOffered(
  rows: readonly PlanOfferingRow[],
  input: { elevationId: string | null; onDate: string },
): boolean {
  return offeredRows(rows, input).length > 0
}

/**
 * The base price the community's sheet quotes for this plan and elevation on a
 * date, or null when the sheet does not price it. Same offering rule as
 * `isPlanOffered`; an elevation's own row outranks the plan-wide row. Two
 * offered rows at the same specificity are an ambiguous sheet and throw: a
 * price is money, so it is never picked by order.
 */
export function resolvePlanBasePrice(
  rows: readonly (PlanOfferingRow & { base_price_cents: number })[],
  input: { elevationId: string | null; onDate: string },
): number | null {
  const offered = offeredRows(rows, input)
  const exact = offered.filter((row) => row.elevation_id !== null)
  const tier = exact.length ? exact : offered
  if (tier.length > 1) throw new Error("Multiple community prices match this plan and elevation; reconcile the price sheet before pricing the home")
  return tier.length ? Number(tier[0].base_price_cents) : null
}

export const MIN_OFFERING_OVERRIDE_REASON_LENGTH = 10

const offeringOverrideSchema = z.object({
  house_plan_id: z.string().uuid(),
  reason: z.string().trim().min(MIN_OFFERING_OVERRIDE_REASON_LENGTH),
  by: z.string().uuid(),
  at: z.string(),
})

/** The recorded exception that lets a lot carry a plan its community does not offer. */
export type OfferingOverride = z.infer<typeof offeringOverrideSchema>

/** The override only speaks for the plan it was recorded against. */
export function offeringOverrideFor(metadata: unknown, housePlanId: string): OfferingOverride | null {
  const parsed = z.object({ offering_override: offeringOverrideSchema }).safeParse(metadata)
  return parsed.success && parsed.data.offering_override.house_plan_id === housePlanId ? parsed.data.offering_override : null
}

export const PLAN_OFFERING_REFUSAL =
  "This plan or elevation is not offered in the lot's community. Offer it there, or record an offering override with a reason."

/** The plan a lot carries an offering override for, if it carries one. */
export function offeringOverridePlanId(metadata: unknown): string | null {
  const parsed = z.object({ offering_override: offeringOverrideSchema }).safeParse(metadata)
  return parsed.success ? parsed.data.offering_override.house_plan_id : null
}
