export type JobCostActualsEntry = {
  org_id?: string | null
  cost_code_id?: string | null
  budget_line_id?: string | null
  source_type?: string | null
  source_id?: string | null
  cost_cents?: number | string | null
  status?: string | null
  is_billable?: boolean | null
}

export interface JobCostActualByCostCode {
  cost_code_id: string | null
  budget_line_id: string | null
  actual_cents: number
  billable_actual_cents: number
  non_billable_actual_cents: number
  entry_count: number
}

export type JobCostGroupBy = "cost_code" | "budget_line"

export function summarizeJobCostEntriesByCostCode(
  entries: JobCostActualsEntry[],
  groupBy: JobCostGroupBy = "cost_code",
): JobCostActualByCostCode[] {
  const grouped = new Map<string, JobCostActualByCostCode>()
  const seenSources = new Set<string>()

  for (const entry of entries) {
    if (entry.status === "voided") continue

    if (entry.source_type && entry.source_id) {
      const sourceKey = `${entry.org_id ?? ""}:${entry.source_type}:${entry.source_id}`
      if (seenSources.has(sourceKey)) continue
      seenSources.add(sourceKey)
    }

    const groupId = groupBy === "budget_line" ? entry.budget_line_id : entry.cost_code_id
    const key = groupId ?? "ungrouped"
    const current =
      grouped.get(key) ??
      ({
        cost_code_id: groupBy === "budget_line" ? null : entry.cost_code_id ?? null,
        budget_line_id: groupBy === "budget_line" ? entry.budget_line_id ?? null : null,
        actual_cents: 0,
        billable_actual_cents: 0,
        non_billable_actual_cents: 0,
        entry_count: 0,
      } satisfies JobCostActualByCostCode)

    const costCents = Math.round(Number(entry.cost_cents ?? 0))
    current.actual_cents += costCents
    if (entry.is_billable) current.billable_actual_cents += costCents
    else current.non_billable_actual_cents += costCents
    current.entry_count += 1
    grouped.set(key, current)
  }

  return Array.from(grouped.values())
}
