import "server-only"

import { z } from "zod"

import { MobileAPIError, mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg, type MobileOrgContext } from "@/lib/mobile/auth"
import { runWithServiceOrgContext } from "@/lib/services/context"
import {
  clockIn,
  clockOut,
  endBreak,
  getClockCostCodes,
  getClockState,
  startBreak,
  switchClock,
  type ClockSession,
} from "@/lib/services/time-clock"
import {
  approveTimeEntries,
  getMyHours,
  getTimesheet,
  rejectTimeEntries,
  type MyHoursPeriod,
  type TimesheetQueueItem,
} from "@/lib/services/timesheets"
import { periodSelectorSchema, timeBulkDecisionSchema, timeBulkRejectSchema } from "@/lib/validation/time-clock"

/**
 * The clock, My hours and the foreman's approval queue from the phone.
 *
 * Everything delegates to the services the web app uses, under the caller's org
 * context. The wire format is snake_case; the services speak camelCase, so the
 * mapping lives here. Hours only: the services never carry rates and neither
 * does this surface.
 */

const projectIdSchema = z.string().uuid()

const locationWire = z
  .object({ lat: z.number(), lng: z.number(), accuracy_m: z.number().optional() })
  .nullable()
  .optional()

const clockInWire = z.object({
  project_id: projectIdSchema,
  cost_code_id: z.string().uuid().nullable().optional(),
  worker_user_id: z.string().uuid().optional(),
  location: locationWire,
})

const clockActionWire = z.object({
  worker_user_id: z.string().uuid().optional(),
  location: locationWire,
})

export interface MobileClockSessionDTO {
  id: string
  project_id: string
  project_name: string
  cost_code_id: string | null
  cost_code_label: string | null
  worker_user_id: string
  work_date: string
  started_at: string
  on_break_since: string | null
  break_minutes: number
  source: "web" | "mobile"
}

function sessionDTO(session: ClockSession): MobileClockSessionDTO {
  return {
    id: session.id,
    project_id: session.projectId,
    project_name: session.projectName,
    cost_code_id: session.costCodeId,
    cost_code_label: session.costCodeLabel,
    worker_user_id: session.workerUserId,
    work_date: session.workDate,
    started_at: session.startedAt,
    on_break_since: session.onBreakSince,
    break_minutes: session.breakMinutes,
    source: session.source,
  }
}

export interface MobileTimeEntryDTO {
  id: string
  worker_name: string
  project_id: string
  project_name: string
  cost_code: string | null
  work_date: string
  hours: number
  kind: TimesheetQueueItem["kind"]
  overtime_source: TimesheetQueueItem["overtimeSource"]
  notes: string | null
}

function entryDTO(entry: TimesheetQueueItem): MobileTimeEntryDTO {
  return {
    id: entry.id,
    worker_name: entry.workerName,
    project_id: entry.projectId,
    project_name: entry.projectName,
    cost_code: entry.costCode,
    work_date: entry.workDate,
    hours: entry.hours,
    kind: entry.kind,
    overtime_source: entry.overtimeSource,
    notes: entry.notes,
  }
}

function periodDTO(period: { startsOn: string; endsOn: string }) {
  return { starts_on: period.startsOn, ends_on: period.endsOn }
}

function myHoursPeriodDTO(hours: MyHoursPeriod) {
  return {
    period: periodDTO(hours.period),
    days: hours.days,
    total_hours: hours.grid?.hours ?? 0,
    regular_hours: hours.grid?.regular ?? 0,
    overtime_hours: hours.grid?.overtime ?? 0,
    double_time_hours: hours.grid?.doubleTime ?? 0,
    entries: hours.entries.map((entry) => ({
      ...entryDTO(entry),
      status: entry.status,
      rejection_reason: entry.rejectionReason,
    })),
  }
}

export async function loadMobileClock(context: MobileOrgContext) {
  const state = await runWithServiceOrgContext(context.serviceContext, () => getClockState(context.orgId))
  return {
    open: state.open ? sessionDTO(state.open) : null,
    jobs: state.jobs,
    jobs_total: state.jobsTotal,
    jobs_cap: state.jobsCap,
    can_clock_others: state.canClockOthers,
  }
}

export async function loadMobileClockCostCodes(context: MobileOrgContext, projectId: unknown) {
  const id = projectIdSchema.parse(projectId)
  const { required, costCodes } = await runWithServiceOrgContext(context.serviceContext, () =>
    getClockCostCodes(id, context.orgId),
  )
  return { required, cost_codes: costCodes }
}

export async function clockInMobile(context: MobileOrgContext, body: unknown) {
  const input = clockInWire.parse(body)
  const session = await runWithServiceOrgContext(context.serviceContext, () =>
    clockIn(
      {
        projectId: input.project_id,
        costCodeId: input.cost_code_id,
        workerUserId: input.worker_user_id,
        location: input.location,
        source: "mobile",
      },
      context.orgId,
    ),
  )
  return { session: sessionDTO(session) }
}

export async function switchClockMobile(context: MobileOrgContext, body: unknown) {
  const input = clockInWire.parse(body)
  const { session } = await runWithServiceOrgContext(context.serviceContext, () =>
    switchClock(
      {
        projectId: input.project_id,
        costCodeId: input.cost_code_id,
        workerUserId: input.worker_user_id,
        location: input.location,
      },
      context.orgId,
    ),
  )
  return { session: sessionDTO(session) }
}

async function breakMobile(
  context: MobileOrgContext,
  body: unknown,
  action: typeof startBreak | typeof endBreak,
) {
  const input = clockActionWire.parse(body)
  const session = await runWithServiceOrgContext(context.serviceContext, () =>
    action({ workerUserId: input.worker_user_id, location: input.location }, context.orgId),
  )
  return { session: sessionDTO(session) }
}

export const startBreakMobile = (context: MobileOrgContext, body: unknown) => breakMobile(context, body, startBreak)
export const endBreakMobile = (context: MobileOrgContext, body: unknown) => breakMobile(context, body, endBreak)

export async function clockOutMobile(context: MobileOrgContext, body: unknown) {
  const input = clockActionWire.parse(body)
  await runWithServiceOrgContext(context.serviceContext, () =>
    clockOut({ workerUserId: input.worker_user_id, location: input.location }, context.orgId),
  )
  return { clocked_out: true }
}

export async function loadMobileMyHours(context: MobileOrgContext) {
  const hours = await runWithServiceOrgContext(context.serviceContext, () => getMyHours(context.orgId))
  return {
    pay_frequency: hours.payFrequency,
    current: myHoursPeriodDTO(hours.current),
    previous: myHoursPeriodDTO(hours.previous),
  }
}

export async function loadMobileApprovals(context: MobileOrgContext, query: URLSearchParams) {
  const period = periodSelectorSchema.parse(query.get("period") ?? undefined)
  const projectId = query.get("project_id")
  const sheet = await runWithServiceOrgContext(context.serviceContext, () =>
    getTimesheet({ period, projectId: projectId ? projectIdSchema.parse(projectId) : null }, context.orgId),
  )
  return {
    period: periodDTO(sheet.period),
    can_approve: sheet.canApprove,
    truncated: sheet.truncated,
    queue: sheet.queue.map(entryDTO),
  }
}

export const approveTimeMobile = (context: MobileOrgContext, body: unknown) =>
  runWithServiceOrgContext(context.serviceContext, () =>
    approveTimeEntries(timeBulkDecisionSchema.parse(body), context.orgId),
  )

export const rejectTimeMobile = (context: MobileOrgContext, body: unknown) =>
  runWithServiceOrgContext(context.serviceContext, () =>
    rejectTimeEntries(timeBulkRejectSchema.parse(body), context.orgId),
  )

/** What the app can act on: a refusal, or a rule the person can fix, never a database failure. */
function timeFailure(error: unknown) {
  if (error instanceof MobileAPIError) return error
  if (error instanceof z.ZodError) {
    return new MobileAPIError(400, "invalid_input", error.issues[0]?.message ?? "Check the entered values.")
  }
  if (error instanceof Error && "code" in error && error.code === "AUTH_FORBIDDEN") {
    return new MobileAPIError(403, "forbidden", "You do not have permission to do this.")
  }
  if (error instanceof Error && !error.message.startsWith("Failed to")) {
    return new MobileAPIError(409, "time_unavailable", error.message)
  }
  return error
}

/** The one wrapper every time route runs through: bearer auth, request id, envelope, error mapping. */
export async function handleMobileTime(
  request: Request,
  work: (context: MobileOrgContext) => Promise<unknown>,
  init?: ResponseInit,
) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    return mobileDataResponse(await work(context), requestId, init)
  } catch (error) {
    return mobileErrorResponse(timeFailure(error), requestId)
  }
}

/** A JSON body, or `{}` when the app sends none (break and clock-out take no required fields). */
export async function optionalJsonBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new z.ZodError([{ code: "custom", path: [], message: "The request body must be valid JSON." }])
  }
}
