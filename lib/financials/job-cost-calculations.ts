export function calculateTimeEntryCostCents(entry: {
  cost_cents?: number | null
  hours?: number | string | null
  base_rate_cents?: number | null
  burden_multiplier?: number | string | null
  is_overtime?: boolean | null
  ot_multiplier?: number | string | null
  is_double_time?: boolean | null
  dt_multiplier?: number | string | null
}) {
  if (entry.cost_cents != null) return Number(entry.cost_cents)
  const premiumMultiplier = entry.is_double_time ? Number(entry.dt_multiplier ?? 2) : entry.is_overtime ? Number(entry.ot_multiplier ?? 1.5) : 1
  return Math.round(
    Number(entry.hours ?? 0) *
      Number(entry.base_rate_cents ?? 0) *
      Number(entry.burden_multiplier ?? 1) *
      premiumMultiplier,
  )
}
