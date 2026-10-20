import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { loadApprovalGateSettings } from "@/lib/financials/approval-gates"
import { recordAudit } from "@/lib/services/audit"
import { authorize, requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { createTimeEntry } from "@/lib/services/cost-plus"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { resolveVisibleProjectIds } from "@/lib/services/projects"
import { loadTimePolicy } from "@/lib/services/time-policy"
import { localWorkDate, minutesBetween, sessionHours } from "@/lib/time/clock"
import {
  clockActionSchema,
  clockInSchema,
  clockSwitchSchema,
} from "@/lib/validation/time-clock"

// The field clock. A session is one stretch of work on one job and cost code;
// clocking out (or switching job) closes it and writes its hours as a time entry,
// which then goes through approval like hand-entered time.

const costCodeShape = z.object({ id: z.string(), code: z.string().nullable(), name: z.string().nullable() })
// PostgREST returns a to-one embed as an object, or as a one-element array.
function embedded<T extends z.ZodTypeAny>(shape: T) {
  return z
    .union([shape, z.array(shape)])
    .nullish()
    .transform((value) => (Array.isArray(value) ? value[0] ?? null : value ?? null))
}

const sessionRow = z.object({
  id: z.string(),
  project_id: z.string(),
  cost_code_id: z.string().nullable(),
  worker_user_id: z.string(),
  work_date: z.string(),
  started_at: z.string(),
  break_started_at: z.string().nullable(),
  break_minutes: z.number(),
  source: z.enum(["web", "mobile"]),
  project: embedded(z.object({ name: z.string() })),
  cost_code: embedded(costCodeShape),
})
export type ClockSession = {
  id: string
  projectId: string
  projectName: string
  costCodeId: string | null
  costCodeLabel: string | null
  workerUserId: string
  workDate: string
  startedAt: string
  onBreakSince: string | null
  breakMinutes: number
  source: "web" | "mobile"
}

const SESSION_SELECT =
  "id, project_id, cost_code_id, worker_user_id, work_date, started_at, break_started_at, break_minutes, source, project:projects(name), cost_code:cost_codes(id, code, name)"

function costCodeLabel(code: { code: string | null; name: string | null } | null) {
  if (!code) return null
  return [code.code, code.name].filter(Boolean).join(" · ") || null
}

function toSession(raw: unknown): ClockSession {
  const row = sessionRow.parse(raw)
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project?.name ?? "Job",
    costCodeId: row.cost_code_id,
    costCodeLabel: costCodeLabel(row.cost_code),
    workerUserId: row.worker_user_id,
    workDate: row.work_date,
    startedAt: row.started_at,
    onBreakSince: row.break_started_at,
    breakMinutes: row.break_minutes,
    source: row.source,
  }
}

type Context = { supabase: SupabaseClient; orgId: string; userId: string }

// Your own clock needs time.write on the job; anyone else's needs time.manage.
async function requireClockAccess(context: Context, projectId: string, workerUserId: string) {
  await requireAuthorization({
    permission: workerUserId === context.userId ? "time.write" : "time.manage",
    userId: context.userId,
    orgId: context.orgId,
    projectId,
    supabase: context.supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: projectId,
  })
}

export type ClockCostCode = { id: string; label: string }

// A job that budgets by cost code asks which one the hours belong to. A job whose
// approval needs a cost code but whose budget names none asks from the company's
// codes, so the clock never makes time that cannot be approved.
export async function loadClockCostCodes(context: Context, projectId: string) {
  const [{ data: budgets, error: budgetError }, gate] = await Promise.all([
    context.supabase.from("budgets").select("id").eq("org_id", context.orgId).eq("project_id", projectId).limit(20),
    loadApprovalGateSettings({ supabase: context.supabase, orgId: context.orgId, projectId }),
  ])
  if (budgetError) throw new Error(`Failed to load the job's cost codes: ${budgetError.message}`)
  const budgetIds = z.array(z.object({ id: z.string() })).parse(budgets ?? []).map((budget) => budget.id)
  const byId = new Map<string, ClockCostCode>()
  if (budgetIds.length) {
    const { data, error } = await context.supabase
      .from("budget_lines")
      .select("cost_code:cost_codes(id, code, name)")
      .eq("org_id", context.orgId)
      .in("budget_id", budgetIds)
      .not("cost_code_id", "is", null)
      .limit(500)
    if (error) throw new Error(`Failed to load the job's cost codes: ${error.message}`)
    for (const line of z.array(z.object({ cost_code: embedded(costCodeShape) })).parse(data ?? [])) {
      const code = line.cost_code
      if (code) byId.set(code.id, { id: code.id, label: costCodeLabel(code) ?? "Cost code" })
    }
  }
  if (!byId.size && gate.cost_codes_enabled) {
    const { data, error } = await context.supabase
      .from("cost_codes")
      .select("id, code, name")
      .eq("org_id", context.orgId)
      .eq("is_active", true)
      .order("code")
      .limit(500)
    if (error) throw new Error(`Failed to load the company's cost codes: ${error.message}`)
    for (const code of z.array(costCodeShape).parse(data ?? [])) byId.set(code.id, { id: code.id, label: costCodeLabel(code) ?? "Cost code" })
  }
  const costCodes = [...byId.values()].sort((a, b) => a.label.localeCompare(b.label))
  return { required: costCodes.length > 0, costCodes }
}

async function assertCostCode(context: Context, projectId: string, costCodeId: string | null | undefined) {
  const { required, costCodes } = await loadClockCostCodes(context, projectId)
  if (!costCodeId) {
    if (required) throw new Error("Pick the cost code for this job.")
    return
  }
  if (required && !costCodes.some((code) => code.id === costCodeId))
    throw new Error("That cost code is not one this job offers.")
}

async function loadOpenSession(context: Context, workerUserId: string) {
  const { data, error } = await context.supabase
    .from("time_clock_sessions")
    .select(SESSION_SELECT)
    .eq("org_id", context.orgId)
    .eq("worker_user_id", workerUserId)
    .is("ended_at", null)
    .maybeSingle()
  if (error) throw new Error(`Failed to load the clock: ${error.message}`)
  return data ? toSession(data) : null
}

const JOB_CAP = 50

export type ClockJob = { id: string; name: string }

export async function getClockState(orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  const [open, visible, canClockOthers] = await Promise.all([
    loadOpenSession(context, userId),
    resolveVisibleProjectIds({ supabase, orgId: resolvedOrgId, userId, includePrecon: false }),
    authorize({ permission: "time.manage", userId, orgId: resolvedOrgId, supabase }).then((decision) => decision.allowed),
  ])
  if (visible?.length === 0) return { open, jobs: [], jobsTotal: 0, jobsCap: JOB_CAP, canClockOthers }
  let query = supabase
    .from("projects")
    .select("id, name", { count: "exact" })
    .eq("org_id", resolvedOrgId)
    .eq("status", "active")
    .order("name")
    .limit(JOB_CAP)
  if (visible) query = query.in("id", visible)
  const { data, count, error } = await query
  if (error) throw new Error(`Failed to load your jobs: ${error.message}`)
  const jobs: ClockJob[] = z.array(z.object({ id: z.string(), name: z.string() })).parse(data ?? [])
  return {
    open,
    jobs,
    jobsTotal: count ?? 0,
    jobsCap: JOB_CAP,
    canClockOthers,
  }
}

export async function getClockCostCodes(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  await requireClockAccess(context, projectId, userId)
  return loadClockCostCodes(context, projectId)
}

async function openSession(
  context: Context,
  input: { projectId: string; costCodeId?: string | null; workerUserId: string; source: "web" | "mobile"; location?: unknown },
  at: Date,
) {
  const { timeZone } = await loadTimePolicy(context.orgId)
  // Clock rows are written by the service role, after the caller's permission check.
  const { data, error } = await createServiceSupabaseClient()
    .from("time_clock_sessions")
    .insert({
      org_id: context.orgId,
      project_id: input.projectId,
      cost_code_id: input.costCodeId ?? null,
      worker_user_id: input.workerUserId,
      work_date: localWorkDate(at, timeZone),
      started_at: at.toISOString(),
      break_started_at: null,
      break_minutes: 0,
      source: input.source,
      start_location: input.location ?? null,
      created_by: context.userId,
    })
    .select(SESSION_SELECT)
    .single()
  if (error?.code === "23505") throw new Error("Already clocked in. Clock out or switch jobs first.")
  if (error || !data) throw new Error(`Failed to clock in: ${error?.message}`)
  const session = toSession(data)
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      eventType: "time_clock_started",
      entityType: "time_clock_session",
      entityId: session.id,
      payload: { project_id: session.projectId, worker_user_id: session.workerUserId, source: session.source },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "insert",
      entityType: "time_clock_session",
      entityId: session.id,
      after: data,
    }),
  ])
  return session
}

// Closes the session and writes its hours as a submitted time entry. The session
// is claimed first (guarded on ended_at) so a double or retried clock-out can
// never write a second entry; if the entry cannot be made the session reopens.
async function closeSession(context: Context, session: ClockSession, at: Date, location: unknown) {
  const endedAt = at.toISOString()
  const breakMinutes =
    session.breakMinutes + (session.onBreakSince ? Math.round(minutesBetween(session.onBreakSince, endedAt)) : 0)
  const { hours, capped } = sessionHours({ started_at: session.startedAt, ended_at: endedAt, break_minutes: breakMinutes })
  const service = createServiceSupabaseClient()
  const { data: claimed, error: claimError } = await service
    .from("time_clock_sessions")
    .update({
      ended_at: endedAt,
      break_started_at: null,
      break_minutes: breakMinutes,
      end_location: location ?? null,
    })
    .eq("org_id", context.orgId)
    .eq("id", session.id)
    .is("ended_at", null)
    .select("id")
  if (claimError) throw new Error(`Failed to clock out: ${claimError.message}`)
  if (!claimed?.length) throw new Error("This clock was already stopped. Reload to see your hours.")

  let entry: Awaited<ReturnType<typeof createTimeEntry>> | null = null
  if (hours > 0) {
    try {
      entry = await createTimeEntry(
        {
          projectId: session.projectId,
          costCodeId: session.costCodeId,
          workerUserId: session.workerUserId,
          workDate: new Date(`${session.workDate}T12:00:00Z`),
          hours,
          notes: capped ? "The clock ran past 24 hours. Check the hours before approving." : null,
          baseRateCents: 0,
          burdenMultiplier: 1,
          isBillable: true,
          isOvertime: false,
          otMultiplier: 1.5,
          isDoubleTime: false,
          dtMultiplier: 2,
          attachedFileIds: [],
        },
        context.orgId,
        { fallbackToOpenDay: new Date(`${localWorkDate(at, (await loadTimePolicy(context.orgId)).timeZone)}T12:00:00Z`) },
      )
    } catch (failure) {
      await service
        .from("time_clock_sessions")
        .update({
          ended_at: null,
          break_started_at: session.onBreakSince,
          break_minutes: session.breakMinutes,
          end_location: null,
        })
        .eq("org_id", context.orgId)
        .eq("id", session.id)
      throw failure
    }
  }
  if (entry) {
    const { error: linkError } = await service
      .from("time_clock_sessions")
      .update({ time_entry_id: entry.id })
      .eq("org_id", context.orgId)
      .eq("id", session.id)
    if (linkError) throw new Error(`Failed to link the clock to its hours: ${linkError.message}`)
  }
  await recordEvent({
    orgId: context.orgId,
    eventType: "time_clock_stopped",
    entityType: "time_clock_session",
    entityId: session.id,
    payload: { project_id: session.projectId, worker_user_id: session.workerUserId, hours, time_entry_id: entry?.id ?? null },
  })
  return { hours, timeEntryId: entry?.id ?? null }
}

async function requireOpenSession(context: Context, workerUserId: string) {
  const session = await loadOpenSession(context, workerUserId)
  if (!session) throw new Error("Not clocked in.")
  await requireClockAccess(context, session.projectId, workerUserId)
  return session
}

export async function clockIn(input: unknown, orgId?: string) {
  const parsed = clockInSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  const workerUserId = parsed.workerUserId ?? userId
  await requireClockAccess(context, parsed.projectId, workerUserId)
  await assertCostCode(context, parsed.projectId, parsed.costCodeId)
  return openSession(context, { ...parsed, workerUserId }, new Date())
}

export async function switchClock(input: unknown, orgId?: string) {
  const parsed = clockSwitchSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  const workerUserId = parsed.workerUserId ?? userId
  const session = await requireOpenSession(context, workerUserId)
  await requireClockAccess(context, parsed.projectId, workerUserId)
  await assertCostCode(context, parsed.projectId, parsed.costCodeId)
  const at = new Date()
  const closed = await closeSession(context, session, at, parsed.location)
  const next = await openSession(context, { ...parsed, workerUserId, source: session.source }, at)
  return { closed, session: next }
}

export async function startBreak(input: unknown, orgId?: string) {
  const parsed = clockActionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  const session = await requireOpenSession(context, parsed.workerUserId ?? userId)
  if (session.onBreakSince) return session
  const { data, error } = await createServiceSupabaseClient()
    .from("time_clock_sessions")
    .update({ break_started_at: new Date().toISOString() })
    .eq("org_id", resolvedOrgId)
    .eq("id", session.id)
    .is("ended_at", null)
    .select(SESSION_SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to start the break: ${error?.message}`)
  return toSession(data)
}

export async function endBreak(input: unknown, orgId?: string) {
  const parsed = clockActionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  const session = await requireOpenSession(context, parsed.workerUserId ?? userId)
  if (!session.onBreakSince) return session
  const minutes = Math.round(minutesBetween(session.onBreakSince, new Date().toISOString()))
  const { data, error } = await createServiceSupabaseClient()
    .from("time_clock_sessions")
    .update({ break_started_at: null, break_minutes: session.breakMinutes + minutes })
    .eq("org_id", resolvedOrgId)
    .eq("id", session.id)
    .is("ended_at", null)
    .select(SESSION_SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to end the break: ${error?.message}`)
  return toSession(data)
}

export async function clockOut(input: unknown, orgId?: string) {
  const parsed = clockActionSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const context = { supabase, orgId: resolvedOrgId, userId }
  const session = await requireOpenSession(context, parsed.workerUserId ?? userId)
  return closeSession(context, session, new Date(), parsed.location)
}
