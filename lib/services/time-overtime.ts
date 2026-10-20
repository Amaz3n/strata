import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"

import { loadTimePolicy } from "@/lib/services/time-policy"
import { allocateOvertime, splitParts, type OvertimeEntry, type OvertimeKind } from "@/lib/time/overtime"
import { workWeekFor } from "@/lib/time/pay-periods"
import type { TimePolicy } from "@/lib/time/policy"

// The overtime rule runs when time is approved: the entry being approved takes the
// regular, overtime and double-time hours its place in the worker's week earns, and
// an entry that crosses a line is split into one entry per kind before approval.

type WeekRow = {
  id: string
  work_date: string
  hours: number | string
  status: string
  is_overtime: boolean
  is_double_time: boolean
  cost_cents: number | null
  metadata: Record<string, unknown> | null
}

export function overtimeSource(metadata: Record<string, unknown> | null | undefined) {
  const source = metadata?.overtime_source
  return source === "rule" || source === "manual" ? source : null
}

// A flag the office set by hand stays; it is shown as an override.
export function manualKind(row: Pick<WeekRow, "is_overtime" | "is_double_time" | "metadata" | "cost_cents">): OvertimeEntry["manual"] {
  if (overtimeSource(row.metadata) === "rule") return null
  if (row.is_double_time) return "double_time"
  if (row.is_overtime) return "overtime"
  return null
}

export async function loadWorkerWeek(args: {
  supabase: SupabaseClient
  orgId: string
  workerUserId: string
  range: { startsOn: string; endsOn: string }
}) {
  const { data, error } = await args.supabase
    .from("time_entries")
    .select("id, work_date, hours, status, is_overtime, is_double_time, cost_cents, metadata")
    .eq("org_id", args.orgId)
    .eq("worker_user_id", args.workerUserId)
    .gte("work_date", args.range.startsOn)
    .lte("work_date", args.range.endsOn)
    .neq("status", "rejected")
    .order("work_date")
    .order("created_at")
    .order("id")
    // A week is at most a few dozen entries; the cap guards a runaway import.
    .limit(500)
  if (error) throw new Error(`Failed to load the worker's week: ${error.message}`)
  return (data ?? []) as WeekRow[]
}

export function weekAllocation(rows: WeekRow[], policy: TimePolicy) {
  return allocateOvertime(
    rows.map((row) => ({
      id: row.id,
      workDate: row.work_date,
      hours: Number(row.hours),
      manual: manualKind(row),
    })),
    policy,
  )
}

// A split-off part is the same work at a different premium.
const SPLIT_COPY_FIELDS = [
  "org_id", "project_id", "cost_code_id", "budget_line_id", "worker_user_id", "worker_company_id",
  "worker_name", "work_date", "base_rate_cents", "burden_multiplier", "is_billable", "ot_multiplier",
  "dt_multiplier", "notes", "attached_file_ids", "status", "labor_cost_policy_version",
] as const

const FLAGS: Record<OvertimeKind, { is_overtime: boolean; is_double_time: boolean }> = {
  regular: { is_overtime: false, is_double_time: false },
  overtime: { is_overtime: true, is_double_time: false },
  double_time: { is_overtime: false, is_double_time: true },
}

// Returns the ids to approve: the entry itself, plus any split-off overtime parts.
export async function applyOvertimeRule(args: {
  supabase: SupabaseClient
  orgId: string
  entry: Record<string, any>
}): Promise<string[]> {
  const { entry } = args
  // cost_cents is generated from hours and rate, so every entry can be split.
  if (!entry.worker_user_id || Number(entry.hours) <= 0) return [entry.id]
  if (manualKind(entry as WeekRow)) {
    if (!overtimeSource(entry.metadata)) {
      await updateEntry(args, entry.id, { metadata: { ...(entry.metadata ?? {}), overtime_source: "manual" } })
    }
    return [entry.id]
  }
  const { policy } = await loadTimePolicy(args.orgId)
  if (!policy.automatic_overtime) return [entry.id]
  const rows = await loadWorkerWeek({
    supabase: args.supabase,
    orgId: args.orgId,
    workerUserId: entry.worker_user_id,
    range: workWeekFor(entry.work_date, policy),
  })
  const split = weekAllocation(rows, policy).get(entry.id)
  if (!split) return [entry.id]
  const [first, ...rest] = splitParts(split)
  if (!first) return [entry.id]
  const metadata = (kind: OvertimeKind) => ({
    ...(entry.metadata ?? {}),
    overtime_source: kind === "regular" ? null : "rule",
  })
  await updateEntry(args, entry.id, {
    hours: first.hours,
    ...FLAGS[first.kind],
    metadata: { ...metadata(first.kind), ...(rest.length ? { overtime_split: true } : {}) },
  })
  if (!rest.length) return [entry.id]
  const copy = Object.fromEntries(SPLIT_COPY_FIELDS.map((field) => [field, entry[field]]))
  const { data, error } = await args.supabase
    .from("time_entries")
    .insert(
      rest.map((part) => ({
        ...copy,
        hours: part.hours,
        ...FLAGS[part.kind],
        metadata: { ...metadata(part.kind), overtime_split_from: entry.id },
      })),
    )
    .select("id")
  if (error) throw new Error(`Failed to split overtime hours: ${error.message}`)
  return [entry.id, ...(data ?? []).map((row: { id: string }) => row.id)]
}

async function updateEntry(
  args: { supabase: SupabaseClient; orgId: string },
  id: string,
  values: Record<string, unknown>,
) {
  const { error } = await args.supabase.from("time_entries").update(values).eq("org_id", args.orgId).eq("id", id)
  if (error) throw new Error(`Failed to apply the overtime rule: ${error.message}`)
}
