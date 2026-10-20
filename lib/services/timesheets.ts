import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { authorize, requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { approveTimeEntry, propagateApprovalToLedger, rejectTimeEntry, updateTimeEntry } from "@/lib/services/cost-plus"
import { recordEvent } from "@/lib/services/events"
import { resolveVisibleProjectIds } from "@/lib/services/projects"
import { loadTimePolicy } from "@/lib/services/time-policy"
import { overtimeSource, weekAllocation } from "@/lib/services/time-overtime"
import { localWorkDate } from "@/lib/time/clock"
import { entryKind, splitParts, type OvertimeKind } from "@/lib/time/overtime"
import {
  datesIn,
  isPayPeriodRange,
  payPeriodFor,
  previousPayPeriod,
  workWeekFor,
  type PayPeriodRange,
} from "@/lib/time/pay-periods"
import type { TimePolicy } from "@/lib/time/policy"
import {
  buildTimesheetGrid,
  isApprovedTime,
  isOpenTime,
  payrollExportCsv,
  summarizePeriod,
  type TimesheetEntry,
} from "@/lib/time/timesheet"
import {
  closePayPeriodSchema,
  payrollExportSchema,
  periodSelectorSchema,
  timeBulkDecisionSchema,
  timeBulkRejectSchema,
  timeCorrectionSchema,
} from "@/lib/validation/time-clock"

// Crew time by pay period: the week grid, My hours, the foreman's approval queue,
// closing and locking a period, the payroll export and corrections to locked time.

type Context = { supabase: SupabaseClient; orgId: string; userId: string }

const ENTRY_CAP = 2000

const embedded = <T extends z.ZodTypeAny>(shape: T) =>
  z
    .union([shape, z.array(shape)])
    .nullish()
    .transform((value) => (Array.isArray(value) ? value[0] ?? null : value ?? null))

const entryRow = z.object({
  id: z.string(),
  worker_user_id: z.string().nullable(),
  worker_name: z.string(),
  project_id: z.string(),
  cost_code_id: z.string().nullable(),
  work_date: z.string(),
  hours: z.coerce.number(),
  status: z.string(),
  rejection_reason: z.string().nullable(),
  notes: z.string().nullable(),
  is_overtime: z.boolean(),
  is_double_time: z.boolean(),
  base_rate_cents: z.number(),
  burden_multiplier: z.coerce.number(),
  ot_multiplier: z.coerce.number(),
  dt_multiplier: z.coerce.number(),
  cost_cents: z.number().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  reverses_time_entry_id: z.string().nullable(),
  project: embedded(z.object({ name: z.string() })),
  cost_code: embedded(z.object({ code: z.string().nullable(), name: z.string().nullable() })),
  worker: embedded(z.object({ email: z.string().nullable() })),
})

const ENTRY_SELECT =
  "id, worker_user_id, worker_name, project_id, cost_code_id, work_date, hours, status, rejection_reason, notes, is_overtime, is_double_time, base_rate_cents, burden_multiplier, ot_multiplier, dt_multiplier, cost_cents, metadata, reverses_time_entry_id, project:projects(name), cost_code:cost_codes(code, name), worker:app_users!time_entries_worker_user_id_fkey(email)"

function toEntry(raw: unknown): TimesheetEntry {
  const row = entryRow.parse(raw)
  return {
    id: row.id,
    worker_user_id: row.worker_user_id,
    worker_name: row.worker_name,
    worker_email: row.worker?.email ?? null,
    project_id: row.project_id,
    project_name: row.project?.name ?? "Job",
    cost_code_id: row.cost_code_id,
    cost_code_label: row.cost_code ? [row.cost_code.code, row.cost_code.name].filter(Boolean).join(" · ") || null : null,
    work_date: row.work_date,
    hours: row.hours,
    status: row.status,
    rejection_reason: row.rejection_reason,
    notes: row.notes,
    is_overtime: row.is_overtime,
    is_double_time: row.is_double_time,
    overtime_source: overtimeSource(row.metadata),
    base_rate_cents: row.base_rate_cents,
    burden_multiplier: row.burden_multiplier,
    ot_multiplier: row.ot_multiplier,
    dt_multiplier: row.dt_multiplier,
    cost_cents: row.cost_cents,
    reverses_time_entry_id: row.reverses_time_entry_id,
  }
}

async function loadEntries(
  context: Context,
  filter: {
    range: PayPeriodRange
    projectId?: string | null
    workerUserId?: string | null
    projectIds?: string[] | null
    statuses?: readonly string[]
  },
) {
  const none: TimesheetEntry[] = []
  if (filter.projectIds?.length === 0) return { entries: none, truncated: false }
  let query = context.supabase
    .from("time_entries")
    .select(ENTRY_SELECT, { count: "exact" })
    .eq("org_id", context.orgId)
    .gte("work_date", filter.range.startsOn)
    .lte("work_date", filter.range.endsOn)
    .order("work_date")
    .order("created_at")
    .order("id")
    .limit(ENTRY_CAP)
  if (filter.projectId) query = query.eq("project_id", filter.projectId)
  if (filter.projectIds) query = query.in("project_id", filter.projectIds)
  if (filter.workerUserId) query = query.eq("worker_user_id", filter.workerUserId)
  if (filter.statuses) query = query.in("status", [...filter.statuses])
  const { data, count, error } = await query
  if (error) throw new Error(`Failed to load time: ${error.message}`)
  return { entries: (data ?? []).map(toEntry), truncated: (count ?? 0) > ENTRY_CAP }
}

async function allowed(context: Context, permission: string, projectId?: string | null) {
  const decision = await authorize({
    permission,
    userId: context.userId,
    orgId: context.orgId,
    projectId: projectId ?? undefined,
    supabase: context.supabase,
  })
  return decision.allowed
}

async function requirePermissionKey(context: Context, permission: string, projectId?: string | null) {
  await requireAuthorization({
    permission,
    userId: context.userId,
    orgId: context.orgId,
    projectId: projectId ?? undefined,
    supabase: context.supabase,
    logDecision: true,
    resourceType: projectId ? "project" : "org",
    resourceId: projectId ?? context.orgId,
  })
}

function todayIn(timeZone: string | null) {
  return localWorkDate(new Date(), timeZone)
}

function resolvePeriod(selector: unknown, policy: TimePolicy, today: string): PayPeriodRange {
  const parsed = periodSelectorSchema.parse(selector)
  const current = payPeriodFor(today, policy)
  if (parsed === "current") return current
  if (parsed === "previous") return previousPayPeriod(current, policy)
  return payPeriodFor(parsed, policy)
}

const periodRow = z.object({
  id: z.string(),
  starts_on: z.string(),
  ends_on: z.string(),
  closed_at: z.string(),
  closed_by: z.string().nullable(),
  books_payroll_import_id: z.string().nullable(),
})
export type ClosedPayPeriod = z.infer<typeof periodRow>
const closeResultSchema = z.object({ period: periodRow, locked: z.number() })

async function loadClosedPeriod(context: Context, range: PayPeriodRange) {
  const { data, error } = await context.supabase
    .from("pay_periods")
    .select("id, starts_on, ends_on, closed_at, closed_by, books_payroll_import_id")
    .eq("org_id", context.orgId)
    .eq("starts_on", range.startsOn)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the pay period: ${error.message}`)
  return data ? periodRow.parse(data) : null
}

// What a person may see: their own time always; the crew's with time.approve or
// time.manage, limited to the jobs they can reach.
async function crewScope(context: Context, projectId?: string | null) {
  const [canApprove, canManage, canClose] = await Promise.all([
    allowed(context, "time.approve", projectId),
    allowed(context, "time.manage", projectId),
    allowed(context, "time.close"),
  ])
  const seesCrew = canApprove || canManage || canClose
  const projectIds = seesCrew && !projectId
    ? await resolveVisibleProjectIds({ supabase: context.supabase, orgId: context.orgId, userId: context.userId, includePrecon: false })
    : null
  return { canApprove, canManage, canClose, seesCrew, projectIds }
}

export type TimesheetQueueItem = {
  id: string
  workerName: string
  projectId: string
  projectName: string
  costCode: string | null
  workDate: string
  hours: number
  kind: OvertimeKind
  overtimeSource: "rule" | "manual" | null
  notes: string | null
}

function toQueueItem(entry: TimesheetEntry): TimesheetQueueItem {
  return {
    id: entry.id,
    workerName: entry.worker_name,
    projectId: entry.project_id,
    projectName: entry.project_name,
    costCode: entry.cost_code_label,
    workDate: entry.work_date,
    hours: entry.hours,
    kind: entryKind(entry),
    overtimeSource: entry.overtime_source,
    notes: entry.notes,
  }
}

// The week grid for /trade/crew (whole crew) or one job's Crew time tab. Rates
// never leave the server: the grid carries hours only.
export async function getTimesheet(input: { period?: unknown; projectId?: string | null } = {}, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  const projectId = input.projectId ?? null
  await requirePermissionKey(context, "time.read", projectId)
  const [{ policy, timeZone }, scope] = await Promise.all([loadTimePolicy(resolvedOrgId), crewScope(context, projectId)])
  const today = todayIn(timeZone)
  const range = resolvePeriod(input.period, policy, today)
  const [{ entries, truncated }, closed] = await Promise.all([
    loadEntries(context, {
      range,
      projectId,
      projectIds: scope.projectIds,
      workerUserId: scope.seesCrew ? null : userId,
    }),
    loadClosedPeriod(context, range),
  ])
  const queue = scope.canApprove ? entries.filter((entry) => entry.status === "submitted").map(toQueueItem) : []
  return {
    policy,
    period: range,
    current: payPeriodFor(today, policy),
    days: datesIn(range),
    grid: buildTimesheetGrid(entries),
    queue,
    truncated,
    entryCap: ENTRY_CAP,
    closed,
    canApprove: scope.canApprove,
    canClose: scope.canClose && !projectId,
    periodEnded: range.endsOn < today,
  }
}

export type MyHoursPeriod = {
  period: PayPeriodRange
  days: string[]
  grid: ReturnType<typeof buildTimesheetGrid>[number] | null
  entries: Array<TimesheetQueueItem & { status: string; rejectionReason: string | null }>
}

// A worker's own hours for the current and last period, rejected entries included
// so they see what came back and why.
export async function getMyHours(orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  const { policy, timeZone } = await loadTimePolicy(resolvedOrgId)
  const current = payPeriodFor(todayIn(timeZone), policy)
  const previous = previousPayPeriod(current, policy)
  const load = async (range: PayPeriodRange): Promise<MyHoursPeriod> => {
    const { entries } = await loadEntries(context, { range, workerUserId: userId })
    return {
      period: range,
      days: datesIn(range),
      grid: buildTimesheetGrid(entries)[0] ?? null,
      entries: entries.map((entry) => ({
        ...toQueueItem(entry),
        status: entry.status,
        rejectionReason: entry.rejection_reason,
      })),
    }
  }
  const [currentHours, previousHours] = await Promise.all([load(current), load(previous)])
  return { current: currentHours, previous: previousHours, payFrequency: policy.pay_frequency }
}

export type BulkResult = { done: string[]; failed: Array<{ id: string; error: string }> }

// A bulk decision reaches only what the caller's queue shows: submitted time on jobs they can reach.
// Anything else comes back as failed, so a guessed id decides nothing.
async function decidableIds(context: Context, ids: string[]) {
  const scope = await crewScope(context)
  if (!scope.canApprove) return { rows: [], refused: ids }
  let query = context.supabase
    .from("time_entries")
    .select("id, project_id, work_date, created_at")
    .eq("org_id", context.orgId)
    .eq("status", "submitted")
    .in("id", ids)
    .order("work_date")
    .order("created_at")
  if (scope.projectIds) query = query.in("project_id", scope.projectIds)
  const { data, error } = await query
  if (error) throw new Error(`Failed to load the time to decide: ${error.message}`)
  const rows = z.array(z.object({ id: z.string() })).parse(data ?? [])
  const found = new Set(rows.map((row) => row.id))
  return { rows, refused: ids.filter((id) => !found.has(id)) }
}

const NOT_IN_QUEUE = "This time is not in your approval queue."

// Approved in work order so each entry's overtime is counted against the hours before it.
export async function approveTimeEntries(input: unknown, orgId?: string): Promise<BulkResult> {
  const { ids } = timeBulkDecisionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { rows, refused } = await decidableIds({ supabase, orgId: resolvedOrgId, userId }, ids)
  const result: BulkResult = { done: [], failed: refused.map((id) => ({ id, error: NOT_IN_QUEUE })) }
  for (const row of rows) {
    try {
      await approveTimeEntry(row.id, resolvedOrgId)
      result.done.push(row.id)
    } catch (failure) {
      result.failed.push({ id: row.id, error: failure instanceof Error ? failure.message : "Could not approve" })
    }
  }
  return result
}

export async function rejectTimeEntries(input: unknown, orgId?: string): Promise<BulkResult> {
  const { ids, reason } = timeBulkRejectSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { rows, refused } = await decidableIds({ supabase, orgId: resolvedOrgId, userId }, ids)
  const result: BulkResult = { done: [], failed: refused.map((id) => ({ id, error: NOT_IN_QUEUE })) }
  for (const row of rows) {
    try {
      await rejectTimeEntry(row.id, { rejectionReason: reason }, orgId)
      result.done.push(row.id)
    } catch (failure) {
      result.failed.push({ id: row.id, error: failure instanceof Error ? failure.message : "Could not send back" })
    }
  }
  return result
}

function assertClosablePeriod(range: PayPeriodRange, policy: TimePolicy, today: string) {
  if (!isPayPeriodRange(range, policy)) throw new Error("That is not one of your pay periods.")
  if (range.endsOn >= today) throw new Error("A pay period can be closed once it has ended.")
}

// Brings approved time in line with the overtime rule before it is locked. Approving
// out of work order can leave an earlier day's hours flagged differently from what
// the week earns; a flag-only difference is fixed here, a difference that would
// need an approved entry split is returned for the office to resolve.
async function reconcileOvertime(context: Context, policy: TimePolicy, entries: TimesheetEntry[]) {
  const needsReview: string[] = []
  if (!policy.automatic_overtime) return needsReview
  const byWorkerWeek = new Map<string, TimesheetEntry[]>()
  for (const entry of entries) {
    if (!entry.worker_user_id || entry.status === "rejected") continue
    const key = `${entry.worker_user_id}|${workWeekFor(entry.work_date, policy).startsOn}`
    byWorkerWeek.set(key, [...(byWorkerWeek.get(key) ?? []), entry])
  }
  for (const [key, weekEntries] of byWorkerWeek) {
    const [workerUserId, weekStart] = key.split("|")
    const week = workWeekFor(weekStart, policy)
    // The week can reach past the period; count all of it.
    const { data, error } = await context.supabase
      .from("time_entries")
      .select("id, work_date, hours, status, is_overtime, is_double_time, cost_cents, metadata")
      .eq("org_id", context.orgId)
      .eq("worker_user_id", workerUserId)
      .gte("work_date", week.startsOn)
      .lte("work_date", week.endsOn)
      .neq("status", "rejected")
      .order("work_date")
      .order("created_at")
      .order("id")
      .limit(500)
    if (error) throw new Error(`Failed to check overtime: ${error.message}`)
    const allocation = weekAllocation(data ?? [], policy)
    for (const entry of weekEntries) {
      if (!isApprovedTime(entry.status) || entry.overtime_source === "manual") continue
      const parts = splitParts(allocation.get(entry.id) ?? { regular: entry.hours, overtime: 0, doubleTime: 0 })
      if (parts.length !== 1) {
        needsReview.push(entry.id)
        continue
      }
      const kind = parts[0].kind
      if (kind === entryKind(entry)) continue
      await updateTimeEntry(
        entry.id,
        { isOvertime: kind === "overtime", isDoubleTime: kind === "double_time" },
        context.orgId,
      )
    }
  }
  return needsReview
}

export async function closePayPeriod(input: unknown, orgId?: string) {
  const { startsOn } = closePayPeriodSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  await requirePermissionKey(context, "time.close")
  const { policy, timeZone } = await loadTimePolicy(resolvedOrgId)
  const range = payPeriodFor(startsOn, policy)
  assertClosablePeriod({ startsOn, endsOn: range.endsOn }, policy, todayIn(timeZone))
  if (await loadClosedPeriod(context, range)) throw new Error("This pay period is already closed.")

  const { entries, truncated } = await loadEntries(context, { range })
  if (truncated) throw new Error(`This period has more than ${ENTRY_CAP} entries. Contact support to close it.`)
  const waiting = entries.filter((entry) => isOpenTime(entry.status))
  if (waiting.length) {
    throw new Error(
      `${waiting.length} ${waiting.length === 1 ? "entry is" : "entries are"} still waiting for approval. Approve or send them back first.`,
    )
  }
  const needsReview = await reconcileOvertime(context, policy, entries)
  if (needsReview.length) {
    throw new Error(
      `${needsReview.length} approved ${needsReview.length === 1 ? "entry crosses" : "entries cross"} an overtime line because time was approved out of order. Send ${needsReview.length === 1 ? "it" : "them"} back and approve again to split the hours.`,
    )
  }

  const { entries: settled } = await loadEntries(context, { range })
  const summary = summarizePeriod(settled)
  const payrollImport = await findPayrollImport(resolvedOrgId, { range })
  // One transaction: refuses overlap, unfinished entries and open clocks, records the
  // period and locks its approved entries. Payroll writes go through the service
  // client after the time.close check above.
  const { data: closed, error: closeError } = await createServiceSupabaseClient().rpc("close_pay_period", {
    p_org_id: resolvedOrgId,
    p_closed_by: userId,
    p_starts_on: range.startsOn,
    p_ends_on: range.endsOn,
    p_summary: summary,
    p_import_id: payrollImport?.id ?? null,
  })
  if (closeError) throw new Error(closeError.message)
  const result = closeResultSchema.parse(closed)
  const period = result.period

  await Promise.all([
    recordEvent({
      orgId: resolvedOrgId,
      eventType: "pay_period_closed",
      entityType: "pay_period",
      entityId: period.id,
      payload: { starts_on: range.startsOn, ends_on: range.endsOn, entries_locked: result.locked, hours: summary.totals.hours },
    }),
    recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "insert",
      entityType: "pay_period",
      entityId: period.id,
      after: { ...period, entries_locked: result.locked },
    }),
  ])
  return { period, summary, locked: result.locked }
}

// Books payroll imports are service-role only; callers have already checked time.close.
async function findPayrollImport(orgId: string, args: { range: { startsOn: string; endsOn: string }; importId?: string | null }) {
  const query = createServiceSupabaseClient()
    .from("books_payroll_imports")
    .select("id, status, reconciliation")
    .eq("org_id", orgId)
  const { data, error } = args.importId
    ? await query.eq("id", args.importId).maybeSingle()
    : await query
        .eq("period_start", args.range.startsOn)
        .eq("period_end", args.range.endsOn)
        .is("withdrawn_at", null)
        .order("prepared_at", { ascending: false })
        .limit(1)
        .maybeSingle()
  if (error) throw new Error(`Failed to load the payroll import: ${error.message}`)
  return data
}

// The period's hours, overtime and cost by worker and by job. Cost is payroll
// data, so it needs time.close.
export async function getPayPeriodSummary(input: { period?: unknown } = {}, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  await requirePermissionKey(context, "time.close")
  const { policy, timeZone } = await loadTimePolicy(resolvedOrgId)
  const today = todayIn(timeZone)
  const range = resolvePeriod(input.period ?? "previous", policy, today)
  const [{ entries, truncated }, closed] = await Promise.all([loadEntries(context, { range }), loadClosedPeriod(context, range)])
  let payrollImport: { id: string; status: string; reconciled: boolean } | null = null
  const importRow = await findPayrollImport(resolvedOrgId, { range, importId: closed?.books_payroll_import_id })
  if (importRow) {
    payrollImport = {
      id: String(importRow.id),
      status: String(importRow.status),
      reconciled: Boolean(importRow.reconciliation && Object.keys(importRow.reconciliation).length),
    }
  }
  return {
    period: range,
    current: payPeriodFor(today, policy),
    closed,
    summary: summarizePeriod(entries),
    waiting: entries.filter((entry) => isOpenTime(entry.status)).length,
    truncated,
    periodEnded: range.endsOn < today,
    payrollImport,
  }
}

export async function exportPayPeriod(input: unknown, orgId?: string) {
  const { startsOn, layout } = payrollExportSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  await requirePermissionKey(context, "time.close")
  const { policy } = await loadTimePolicy(resolvedOrgId)
  const range = payPeriodFor(startsOn, policy)
  const closed = await loadClosedPeriod(context, range)
  if (!closed) throw new Error("Close the pay period before exporting it.")
  const { entries, truncated } = await loadEntries(context, { range })
  if (truncated) throw new Error(`This period has more than ${ENTRY_CAP} entries. Contact support to export it.`)
  const csv = payrollExportCsv(entries, layout, range)
  await Promise.all([
    recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "insert",
      entityType: "payroll_hours_export",
      entityId: closed.id,
      after: { pay_period_id: closed.id, layout, starts_on: range.startsOn, ends_on: range.endsOn, rows: entries.length },
      source: "payroll_hours_export",
      // Payroll hours leaving Arc always leave a record.
      critical: true,
    }),
    recordEvent({
      orgId: resolvedOrgId,
      eventType: "pay_period_exported",
      entityType: "pay_period",
      entityId: closed.id,
      payload: { layout },
    }),
  ])
  return { csv, filename: `payroll-hours-${range.startsOn}-to-${range.endsOn}-${layout}.csv` }
}

// A locked entry is the payroll record and never changes. A correction reverses it
// (negative hours, approved, in the current period) and, when the hours were wrong
// rather than never worked, records the right hours as a new entry that goes
// through approval. Both land in the period that is open now, as payroll adjustments do.
export async function correctLockedTimeEntry(input: unknown, orgId?: string) {
  const parsed = timeCorrectionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  await requirePermissionKey(context, "time.close")
  const { data: original, error } = await supabase
    .from("time_entries")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.timeEntryId)
    .maybeSingle()
  if (error || !original) throw new Error("Time entry not found")
  if (original.status !== "locked") throw new Error("Only time in a closed pay period needs a correction. Edit this entry instead.")
  if (original.reverses_time_entry_id) throw new Error("A correction cannot itself be corrected.")
  const { data: existing } = await supabase
    .from("time_entries")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("reverses_time_entry_id", original.id)
    .maybeSingle()
  if (existing) throw new Error("This entry has already been corrected.")

  const { timeZone } = await loadTimePolicy(resolvedOrgId)
  const today = todayIn(timeZone)
  const now = new Date().toISOString()
  const carried = {
    org_id: resolvedOrgId,
    project_id: original.project_id,
    budget_line_id: original.budget_line_id,
    worker_user_id: original.worker_user_id,
    worker_company_id: original.worker_company_id,
    worker_name: original.worker_name,
    base_rate_cents: original.base_rate_cents,
    burden_multiplier: original.burden_multiplier,
    is_billable: original.is_billable,
    ot_multiplier: original.ot_multiplier,
    dt_multiplier: original.dt_multiplier,
    labor_cost_policy_version: original.labor_cost_policy_version,
    work_date: today,
  }
  const { data: reversal, error: reversalError } = await supabase
    .from("time_entries")
    .insert({
      ...carried,
      cost_code_id: original.cost_code_id,
      hours: -Number(original.hours),
      is_overtime: original.is_overtime,
      is_double_time: original.is_double_time,
      status: "pm_approved",
      approved_by_pm_at: now,
      approved_by_pm_user_id: userId,
      approved_by_client_at: original.approved_by_client_at,
      reverses_time_entry_id: original.id,
      notes: `Correction: ${parsed.reason}`,
      metadata: { correction_of_work_date: original.work_date, overtime_source: overtimeSource(original.metadata) },
    })
    .select("*")
    .single()
  if (reversalError?.code === "23505") throw new Error("This entry has already been corrected.")
  if (reversalError || !reversal) throw new Error(`Failed to reverse the entry: ${reversalError?.message}`)
  await propagateApprovalToLedger({ source: "time_entry", sourceId: reversal.id, orgId: resolvedOrgId })

  let replacement: { id: string } | null = null
  if (parsed.hours !== null) {
    const { data, error: replacementError } = await supabase
      .from("time_entries")
      .insert({
        ...carried,
        cost_code_id: parsed.costCodeId === undefined ? original.cost_code_id : parsed.costCodeId,
        hours: parsed.hours,
        status: "submitted",
        notes: `Corrected hours for ${original.work_date}: ${parsed.reason}`,
        metadata: { correction_of: original.id, correction_of_work_date: original.work_date },
      })
      .select("id")
      .single()
    if (replacementError || !data) throw new Error(`Failed to record the corrected hours: ${replacementError?.message}`)
    replacement = data
  }

  await Promise.all([
    recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "insert",
      entityType: "time_entry",
      entityId: reversal.id,
      after: { ...reversal, replacement_id: replacement?.id ?? null },
    }),
    recordEvent({
      orgId: resolvedOrgId,
      eventType: "time_entry_corrected",
      entityType: "time_entry",
      entityId: original.id,
      payload: { reversal_id: reversal.id, replacement_id: replacement?.id ?? null, reason: parsed.reason },
    }),
  ])
  return { reversalId: String(reversal.id), replacementId: replacement?.id ?? null }
}
