"use strict"

// Crew time and payroll (lib/time and the clock, overtime and pay-period services).

require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const { allocateOvertime } = require("@/lib/time/overtime")
const { payPeriodFor, previousPayPeriod, workWeekFor, datesIn } = require("@/lib/time/pay-periods")
const { sessionHours, localWorkDate } = require("@/lib/time/clock")
const { resolveTimePolicy, defaultTimePolicy, timePolicySchema } = require("@/lib/time/policy")
const { buildTimesheetGrid, summarizePeriod, payrollExportCsv } = require("@/lib/time/timesheet")

// The clock hands finished hours to createTimeEntry, whose pricing and approval
// have their own suites; here it only records what the clock asked for.
let timeEntriesCreated = []
let timeEntryFailure = null
const realCostPlus = { ...require("@/lib/services/cost-plus") }
stubModule("@/lib/services/cost-plus", {
  ...realCostPlus,
  createTimeEntry: async (input) => {
    if (timeEntryFailure) throw new Error(timeEntryFailure)
    timeEntriesCreated.push(input)
    return { id: id(7000 + timeEntriesCreated.length) }
  },
  propagateApprovalToLedger: async () => undefined,
})

const { clockIn, clockOut, startBreak } = freshRequire("lib/services/time-clock.ts")
const { applyOvertimeRule } = freshRequire("lib/services/time-overtime.ts")
const { approveTimeEntries, closePayPeriod, correctLockedTimeEntry, exportPayPeriod } = freshRequire("lib/services/timesheets.ts")

const WEEKLY = { weekly_overtime_hours: 40, daily_overtime_hours: null, daily_double_time_hours: null }
const CALIFORNIA = { weekly_overtime_hours: 40, daily_overtime_hours: 8, daily_double_time_hours: 12 }
// close_pay_period's own rules (overlap, open clocks, atomic lock) are proved against real SQL in
// time-db.test.js; here the service only needs the period recorded and approved time locked.
const closePayPeriodRpc = (args, store) => {
  const period = { id: id(7900), org_id: args.p_org_id, starts_on: args.p_starts_on, ends_on: args.p_ends_on, closed_at: new Date().toISOString(), closed_by: args.p_closed_by, books_payroll_import_id: args.p_import_id }
  store.pay_periods.push(period)
  const rows = store.time_entries.filter((row) => row.work_date >= args.p_starts_on && row.work_date <= args.p_ends_on && ["pm_approved", "client_approved"].includes(row.status))
  for (const row of rows) Object.assign(row, { status: "locked", locked_by: args.p_closed_by, pay_period_id: period.id })
  return { data: { period, locked: rows.length }, error: null }
}
const day = (n) => `2026-10-${String(n).padStart(2, "0")}`

test("hours past forty in a week are overtime, and the entry that crosses the line is split", () => {
  const entries = [12, 13, 14, 15].map((d, index) => ({ id: `e${index}`, workDate: day(d), hours: 10, manual: null }))
  entries.push({ id: "late", workDate: day(16), hours: 6, manual: null })
  const split = allocateOvertime(entries, WEEKLY)
  assert.deepEqual(split.get("e3"), { regular: 10, overtime: 0, doubleTime: 0 })
  assert.deepEqual(split.get("late"), { regular: 0, overtime: 6, doubleTime: 0 })

  const crossing = allocateOvertime(
    [
      { id: "a", workDate: day(12), hours: 38, manual: null },
      { id: "b", workDate: day(13), hours: 4.5, manual: null },
    ],
    { ...WEEKLY, weekly_overtime_hours: 40 },
  )
  assert.deepEqual(crossing.get("b"), { regular: 2, overtime: 2.5, doubleTime: 0 })
})

test("daily lines apply first and double time starts past the second line", () => {
  const split = allocateOvertime(
    [
      { id: "morning", workDate: day(12), hours: 6, manual: null },
      { id: "afternoon", workDate: day(12), hours: 7.25, manual: null },
    ],
    CALIFORNIA,
  )
  assert.deepEqual(split.get("morning"), { regular: 6, overtime: 0, doubleTime: 0 })
  assert.deepEqual(split.get("afternoon"), { regular: 2, overtime: 4, doubleTime: 1.25 })
})

test("a flag the office set by hand stays and does not count toward regular hours", () => {
  const split = allocateOvertime(
    [
      { id: "flagged", workDate: day(12), hours: 8, manual: "double_time" },
      { id: "regular", workDate: day(13), hours: 40, manual: null },
    ],
    WEEKLY,
  )
  assert.deepEqual(split.get("flagged"), { regular: 0, overtime: 0, doubleTime: 8 })
  assert.deepEqual(split.get("regular"), { regular: 40, overtime: 0, doubleTime: 0 })
})

test("pay periods follow the anchor, weekly or every two weeks, before and after it", () => {
  const biweekly = { ...defaultTimePolicy(true), pay_frequency: "biweekly", pay_anchor_date: "2026-10-05" }
  assert.deepEqual(payPeriodFor("2026-10-18", biweekly), { startsOn: "2026-10-05", endsOn: "2026-10-18" })
  assert.deepEqual(payPeriodFor("2026-10-19", biweekly), { startsOn: "2026-10-19", endsOn: "2026-11-01" })
  assert.deepEqual(payPeriodFor("2026-10-04", biweekly), { startsOn: "2026-09-21", endsOn: "2026-10-04" })
  assert.deepEqual(previousPayPeriod({ startsOn: "2026-10-19", endsOn: "2026-11-01" }, biweekly), {
    startsOn: "2026-10-05",
    endsOn: "2026-10-18",
  })
  // Overtime weeks are whole weeks inside a biweekly period.
  assert.deepEqual(workWeekFor("2026-10-14", biweekly), { startsOn: "2026-10-12", endsOn: "2026-10-18" })
  assert.equal(datesIn({ startsOn: "2026-10-05", endsOn: "2026-10-18" }).length, 14)
})

test("a trade gets the forty-hour rule by default and a builder keeps manual flags", () => {
  assert.equal(resolveTimePolicy({}, true).automatic_overtime, true)
  assert.equal(resolveTimePolicy({}, false).automatic_overtime, false)
  const saved = { ...defaultTimePolicy(false), automatic_overtime: true, weekly_overtime_hours: 44 }
  assert.equal(resolveTimePolicy({ time_policy: saved }, false).weekly_overtime_hours, 44)
  assert.equal(
    timePolicySchema.safeParse({ ...saved, daily_overtime_hours: 10, daily_double_time_hours: 8 }).success,
    false,
  )
})

test("a session earns elapsed time less breaks, capped at a day", () => {
  assert.deepEqual(
    sessionHours({ started_at: "2026-10-12T14:00:00Z", ended_at: "2026-10-12T22:30:00Z", break_minutes: 30 }),
    { hours: 8, capped: false },
  )
  assert.deepEqual(
    sessionHours({ started_at: "2026-10-12T14:00:00Z", ended_at: "2026-10-14T14:00:00Z", break_minutes: 0 }),
    { hours: 24, capped: true },
  )
  // Clocking in at 6pm in Los Angeles is that evening's work day, not tomorrow's UTC date.
  assert.equal(localWorkDate(new Date("2026-10-13T01:00:00Z"), "America/Los_Angeles"), "2026-10-12")
})

function sheetEntry(overrides) {
  return {
    id: "x",
    worker_user_id: id(10),
    worker_name: "Ana Ruiz",
    worker_email: "ana@example.com",
    project_id: id(20),
    project_name: "Maple Clinic",
    cost_code_id: null,
    cost_code_label: "26-100 · Rough-in",
    work_date: day(12),
    hours: 8,
    status: "pm_approved",
    rejection_reason: null,
    notes: null,
    is_overtime: false,
    is_double_time: false,
    overtime_source: null,
    base_rate_cents: 4000,
    burden_multiplier: 1.25,
    ot_multiplier: 1.5,
    dt_multiplier: 2,
    cost_cents: null,
    reverses_time_entry_id: null,
    ...overrides,
  }
}

test("the grid shows rejected time to the worker without counting it, and payroll counts approved time only", () => {
  const entries = [
    sheetEntry({ id: "a" }),
    sheetEntry({ id: "b", work_date: day(13), hours: 2, is_overtime: true, status: "locked" }),
    sheetEntry({ id: "c", work_date: day(13), hours: 3, status: "submitted" }),
    sheetEntry({ id: "d", work_date: day(14), hours: 5, status: "rejected" }),
  ]
  const [worker] = buildTimesheetGrid(entries)
  assert.equal(worker.hours, 13)
  assert.equal(worker.overtime, 2)
  assert.deepEqual([worker.waiting, worker.approved, worker.rejected], [1, 2, 1])
  assert.equal(worker.dayTotals[day(13)], 5)

  const summary = summarizePeriod(entries)
  assert.equal(summary.totals.hours, 10)
  // 8h × $40 × 1.25 + 2h × $40 × 1.25 × 1.5
  assert.equal(summary.totals.costCents, 40000 + 15000)
})

test("the payroll export splits regular, overtime and double time and defuses spreadsheet formulas", () => {
  const entries = [
    sheetEntry({ id: "a" }),
    sheetEntry({ id: "b", hours: 2, is_overtime: true }),
    sheetEntry({ id: "c", worker_user_id: id(11), worker_name: "=HYPERLINK(1)", worker_email: null, hours: 4 }),
    sheetEntry({ id: "d", status: "submitted", hours: 9 }),
  ]
  const period = { startsOn: day(12), endsOn: day(18) }
  const gusto = payrollExportCsv(entries, "gusto", period).split("\n")
  assert.equal(gusto[0], "last_name,first_name,email,regular_hours,overtime_hours,double_overtime_hours")
  assert.ok(gusto.includes("Ruiz,Ana,ana@example.com,8.00,2.00,0.00"))
  assert.ok(gusto.some((line) => line.startsWith(",'=HYPERLINK(1),")))
  const generic = payrollExportCsv(entries, "generic", period).split("\n")
  assert.equal(generic.length, 3)
  assert.ok(generic.includes(`${day(12)},${day(18)},Ana Ruiz,ana@example.com,Maple Clinic,26-100 · Rough-in,8.00,2.00,0.00,550.00`))
})

const JOB = id(20)
const WORKER = id(10)
const CODE = id(30)

function trade(tables = {}) {
  return {
    org_settings: [{ org_id: ORG, settings: { business_profile: { kind: "trade", specialty: "Electrical" } } }],
    orgs: [{ id: ORG, time_zone: "America/Chicago" }],
    projects: [{ id: JOB, org_id: ORG, name: "Maple Clinic", status: "active" }],
    budgets: [],
    budget_lines: [],
    time_clock_sessions: [],
    time_entries: [],
    pay_periods: [],
    books_payroll_imports: [],
    ...tables,
  }
}

test("a worker clocks their own time; clocking in someone else needs time.manage", async () => {
  timeEntriesCreated = []
  // Crew reach a job through its membership, as they do in the app.
  const service = createServiceHarness({ tables: trade(), permissions: ["time.write"], projects: [JOB] })
  const session = await service.run(() => clockIn({ projectId: JOB, source: "mobile" }))
  assert.equal(session.workerUserId, ACTOR)
  assert.equal(session.source, "mobile")
  assert.ok(service.events.some((event) => event.eventType === "time_clock_started"))

  await assert.rejects(service.run(() => clockIn({ projectId: JOB, workerUserId: WORKER })))
  assert.equal(service.writes("time_clock_sessions").length, 1)
})

test("a job that budgets by cost code will not clock in without one", async () => {
  const service = createServiceHarness({
    tables: trade({
      budgets: [{ id: id(40), org_id: ORG, project_id: JOB }],
      budget_lines: [{ id: id(41), org_id: ORG, budget_id: id(40), cost_code_id: CODE, cost_code: { id: CODE, code: "26-100", name: "Rough-in" } }],
    }),
    permissions: ["time.write"],
    projects: [JOB],
  })
  await assert.rejects(service.run(() => clockIn({ projectId: JOB })), /cost code/)
  const session = await service.run(() => clockIn({ projectId: JOB, costCodeId: CODE }))
  assert.equal(session.costCodeId, CODE)
})

test("clocking out writes the hours, less the break, as the worker's time entry", async () => {
  timeEntriesCreated = []
  const startedAt = new Date(Date.now() - 9 * 3600_000).toISOString()
  const service = createServiceHarness({
    tables: trade({
      time_clock_sessions: [
        {
          id: id(50),
          org_id: ORG,
          project_id: JOB,
          cost_code_id: null,
          worker_user_id: ACTOR,
          work_date: day(12),
          started_at: startedAt,
          ended_at: null,
          break_started_at: null,
          break_minutes: 60,
          source: "web",
        },
      ],
    }),
    permissions: ["time.write"],
    projects: [JOB],
  })
  const result = await service.run(() => clockOut({}))
  assert.equal(result.hours, 8)
  assert.equal(timeEntriesCreated.length, 1)
  assert.equal(timeEntriesCreated[0].workerUserId, ACTOR)
  assert.equal(timeEntriesCreated[0].hours, 8)
  assert.equal(service.db.time_clock_sessions[0].time_entry_id, result.timeEntryId)
  await assert.rejects(service.run(() => startBreak({})), /Not clocked in/)
})

function entry(overrides) {
  return {
    org_id: ORG,
    project_id: JOB,
    cost_code_id: null,
    budget_line_id: null,
    worker_user_id: WORKER,
    worker_company_id: null,
    worker_name: "Ana Ruiz",
    hours: 8,
    base_rate_cents: 4000,
    burden_multiplier: 1,
    is_billable: true,
    is_overtime: false,
    ot_multiplier: 1.5,
    is_double_time: false,
    dt_multiplier: 2,
    notes: null,
    attached_file_ids: [],
    status: "submitted",
    labor_cost_policy_version: 1,
    cost_cents: 32000, // generated by the database: 8h × $40
    metadata: {},
    reverses_time_entry_id: null,
    rejection_reason: null,
    approved_by_client_at: null,
    created_at: "2026-10-12T00:00:00Z",
    ...overrides,
  }
}

test("approving the entry that crosses forty hours splits off the overtime first", async () => {
  const week = [12, 13, 14, 15].map((d, index) =>
    entry({ id: id(60 + index), work_date: day(d), hours: 9.5, status: "pm_approved" }),
  )
  const crossing = entry({ id: id(70), work_date: day(16), hours: 4 })
  const service = createServiceHarness({ tables: trade({ time_entries: [...week, crossing] }), permissions: [] })
  const ids = await service.run(() =>
    applyOvertimeRule({ supabase: service.client, orgId: ORG, entry: { ...crossing } }),
  )
  assert.equal(ids.length, 2)
  const original = service.db.time_entries.find((row) => row.id === id(70))
  const part = service.db.time_entries.find((row) => row.id === ids[1])
  assert.deepEqual([original.hours, original.is_overtime], [2, false])
  assert.deepEqual([part.hours, part.is_overtime, part.status, part.metadata.overtime_split_from], [2, true, "submitted", id(70)])
})

test("a builder without the rule keeps manual overtime", async () => {
  const crossing = entry({ id: id(70), work_date: day(16), hours: 12 })
  const service = createServiceHarness({
    tables: trade({
      org_settings: [{ org_id: ORG, settings: {} }],
      time_entries: [entry({ id: id(60), work_date: day(12), hours: 24, status: "pm_approved" }), entry({ id: id(61), work_date: day(13), hours: 24, status: "pm_approved" }), crossing],
    }),
    permissions: [],
  })
  const ids = await service.run(() => applyOvertimeRule({ supabase: service.client, orgId: ORG, entry: { ...crossing } }))
  assert.deepEqual(ids, [id(70)])
  assert.equal(service.writes("time_entries").length, 0)
})

test("a period closes only once it has ended and nothing is waiting, and closing locks the approved time", async () => {
  const tables = trade({
    org_settings: [
      {
        org_id: ORG,
        settings: {
          business_profile: { kind: "trade", specialty: "Electrical" },
          time_policy: { ...defaultTimePolicy(true), pay_anchor_date: "2026-09-07" },
        },
      },
    ],
    time_entries: [
      entry({ id: id(80), work_date: "2026-09-08", status: "pm_approved", project: { name: "Maple Clinic" } }),
      entry({ id: id(81), work_date: "2026-09-09", status: "submitted", project: { name: "Maple Clinic" } }),
      entry({ id: id(82), work_date: "2026-09-10", status: "rejected", project: { name: "Maple Clinic" } }),
    ],
  })
  const service = createServiceHarness({ tables, permissions: ["time.close"], rpc: { close_pay_period: closePayPeriodRpc } })
  await assert.rejects(service.run(() => closePayPeriod({ startsOn: "2026-09-07" })), /waiting for approval/)
  await assert.rejects(service.run(() => closePayPeriod({ startsOn: "2026-09-08" })), /not one of your pay periods/)
  await assert.rejects(service.run(() => exportPayPeriod({ startsOn: "2026-09-07" })), /Close the pay period/)

  service.db.time_entries.find((row) => row.id === id(81)).status = "rejected"
  const closed = await service.run(() => closePayPeriod({ startsOn: "2026-09-07" }))
  assert.equal(closed.locked, 1)
  const locked = service.db.time_entries.find((row) => row.id === id(80))
  assert.deepEqual([locked.status, locked.locked_by, locked.pay_period_id], ["locked", ACTOR, closed.period.id])
  assert.equal(service.db.time_entries.find((row) => row.id === id(82)).status, "rejected")
  assert.equal(closed.summary.totals.hours, 8)

  const exported = await service.run(() => exportPayPeriod({ startsOn: "2026-09-07", layout: "gusto" }))
  assert.match(exported.csv, /Ruiz,Ana,,8\.00,0\.00,0\.00/)
  assert.ok(service.audits.some((audit) => audit.entityType === "payroll_hours_export"))
  await assert.rejects(service.run(() => closePayPeriod({ startsOn: "2026-09-07" })), /already closed/)
})

test("a bulk decision reaches only submitted time in the caller's queue", async () => {
  const time_entries = [
    entry({ id: id(60), work_date: "2026-09-08", status: "pm_approved", project: { name: "Maple Clinic" } }),
    entry({ id: id(61), work_date: "2026-09-09", status: "locked", project: { name: "Maple Clinic" } }),
  ]
  const approver = createServiceHarness({ tables: trade({ time_entries }), permissions: ["time.approve", "time.read"] })
  const done = await approver.run(() => approveTimeEntries({ ids: [id(60), id(61)] }))
  assert.deepEqual(done.done, [])
  assert.deepEqual(done.failed.map((row) => row.error), ["This time is not in your approval queue.", "This time is not in your approval queue."])

  const worker = createServiceHarness({ tables: trade({ time_entries }), permissions: ["time.write", "time.read"] })
  const refused = await worker.run(() => approveTimeEntries({ ids: [id(60)] }))
  assert.equal(refused.done.length, 0)
  assert.equal(worker.writes().length, 0)
})

test("closing needs time.close", async () => {
  const service = createServiceHarness({ tables: trade(), permissions: ["time.approve", "time.write"] })
  await assert.rejects(service.run(() => closePayPeriod({ startsOn: "2026-09-07" })))
  assert.equal(service.writes().length, 0)
})

test("a locked entry is corrected by reversing it and recording the right hours for approval", async () => {
  const locked = entry({ id: id(90), work_date: "2026-09-08", hours: 8, status: "locked", project: { name: "Maple Clinic" } })
  const service = createServiceHarness({ tables: trade({ time_entries: [locked] }), permissions: ["time.close"] })
  const result = await service.run(() =>
    correctLockedTimeEntry({ timeEntryId: id(90), hours: 6, reason: "Left at 1pm" }),
  )
  const reversal = service.db.time_entries.find((row) => row.id === result.reversalId)
  const replacement = service.db.time_entries.find((row) => row.id === result.replacementId)
  assert.deepEqual([reversal.hours, reversal.status, reversal.reverses_time_entry_id], [-8, "pm_approved", id(90)])
  assert.deepEqual([replacement.hours, replacement.status], [6, "submitted"])
  assert.equal(service.db.time_entries.find((row) => row.id === id(90)).hours, 8)
  await assert.rejects(
    service.run(() => correctLockedTimeEntry({ timeEntryId: id(90), hours: null, reason: "again" })),
    /already been corrected/,
  )
})

test("a raise starts on its date and earlier work keeps the old rate", async () => {
  const { resolveLaborRate } = freshRequire("lib/services/labor-rates.ts")
  const service = createServiceHarness({
    tables: {
      labor_rates: [
        { org_id: ORG, user_id: WORKER, effective_on: "2026-01-05", cost_rate_cents: 3500, burden_multiplier: 1.2, bill_rate_cents: 8500 },
        { org_id: ORG, user_id: WORKER, effective_on: "2026-10-12", cost_rate_cents: 3800, burden_multiplier: 1.2, bill_rate_cents: 9000 },
      ],
      memberships: [],
    },
    permissions: [],
  })
  const before = await service.run(() => resolveLaborRate({ supabase: service.client, orgId: ORG, userId: WORKER, onDate: "2026-10-09" }))
  const after = await service.run(() => resolveLaborRate({ supabase: service.client, orgId: ORG, userId: WORKER, onDate: "2026-10-12" }))
  assert.deepEqual([before.costRateCents, before.billRateCents], [3500, 8500])
  assert.deepEqual([after.costRateCents, after.billRateCents, after.effectiveOn], [3800, 9000, "2026-10-12"])
})

const openSession = (overrides = {}) => ({
  id: id(50),
  org_id: ORG,
  project_id: JOB,
  cost_code_id: null,
  worker_user_id: ACTOR,
  work_date: day(12),
  started_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
  ended_at: null,
  break_started_at: null,
  break_minutes: 0,
  source: "web",
  ...overrides,
})

test("a double clock-out writes one entry, and a failed entry reopens the clock", async () => {
  timeEntriesCreated = []
  const service = createServiceHarness({ tables: trade({ time_clock_sessions: [openSession()] }), permissions: ["time.write"], projects: [JOB] })
  const results = await Promise.allSettled([service.run(() => clockOut({})), service.run(() => clockOut({}))])
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(timeEntriesCreated.length, 1)

  const failing = createServiceHarness({ tables: trade({ time_clock_sessions: [openSession()] }), permissions: ["time.write"], projects: [JOB] })
  timeEntryFailure = "That pay period is closed."
  try {
    await assert.rejects(failing.run(() => clockOut({})), /pay period/)
  } finally {
    timeEntryFailure = null
  }
  assert.equal(failing.db.time_clock_sessions[0].ended_at, null)
})

test("a clock that began in a period closed since is dated on the first open day", async () => {
  const service = createServiceHarness({
    tables: trade({ pay_periods: [{ id: id(80), org_id: ORG, starts_on: day(12), ends_on: day(18) }, { id: id(81), org_id: ORG, starts_on: day(12), ends_on: day(18) }] }),
    permissions: ["time.write"],
    projects: [JOB],
  })
  const input = { projectId: JOB, workDate: new Date(`${day(14)}T12:00:00Z`), hours: 2, baseRateCents: 0, burdenMultiplier: 1, attachedFileIds: [] }
  await assert.rejects(service.run(() => realCostPlus.createTimeEntry(input)), /pay period is closed/)
  const created = await service.run(() => realCostPlus.createTimeEntry(input, undefined, { fallbackToOpenDay: new Date(`${day(20)}T12:00:00Z`) }))
  assert.equal(created.work_date, day(20))
  assert.equal(created.metadata.clock_started_on, day(14))
})

test("a worker's own entry is priced from the rate on file, not the one they send", async () => {
  const tables = trade({
    labor_rates: [{ org_id: ORG, user_id: ACTOR, effective_on: day(1), cost_rate_cents: 3000, burden_multiplier: 1.3, bill_rate_cents: 5000 }],
    app_users: [{ id: ACTOR, full_name: "Sam Field", email: "sam@example.com" }],
  })
  const send = { projectId: JOB, workDate: new Date(`${day(14)}T12:00:00Z`), hours: 8, baseRateCents: 99900, burdenMultiplier: 3, isOvertime: true, otMultiplier: 2, attachedFileIds: [] }
  const worker = createServiceHarness({ tables, permissions: ["time.write"], projects: [JOB] })
  const own = await worker.run(() => realCostPlus.createTimeEntry(send))
  assert.deepEqual([own.base_rate_cents, own.burden_multiplier, own.is_overtime, own.ot_multiplier], [3000, 1.3, false, 1.5])
  const office = createServiceHarness({ tables: trade({ ...tables }), permissions: ["time.write", "time.manage"], projects: [JOB] })
  const priced = await office.run(() => realCostPlus.createTimeEntry(send))
  assert.deepEqual([priced.base_rate_cents, priced.is_overtime], [99900, true])
})

test("a worker cannot reprice or edit approved time, and cannot approve their own", async () => {
  const mine = entry({ id: id(90), worker_user_id: ACTOR, status: "submitted" })
  const approved = entry({ id: id(91), worker_user_id: ACTOR, status: "pm_approved" })
  const worker = createServiceHarness({ tables: trade({ time_entries: [mine, approved] }), permissions: ["time.write"], projects: [JOB] })
  await assert.rejects(worker.run(() => realCostPlus.updateTimeEntry(id(90), { baseRateCents: 99900 })), /set by the office/)
  await assert.rejects(worker.run(() => realCostPlus.updateTimeEntry(id(91), { notes: "late edit" })))

  const foreman = createServiceHarness({ tables: trade({ time_entries: [mine] }), permissions: ["time.write", "time.approve"], projects: [JOB] })
  await assert.rejects(foreman.run(() => realCostPlus.approveTimeEntry(id(90))), /your own time/)
  assert.equal(foreman.db.time_entries[0].status, "submitted")
})

test("crew see only their own hours and no rates; managers see everyone with rates; no token hash leaves", async () => {
  const rows = [
    entry({ id: id(92), worker_user_id: ACTOR, approval_token_hash: "secret" }),
    entry({ id: id(93), worker_user_id: WORKER, approval_token_hash: "secret" }),
  ]
  const crew = createServiceHarness({ tables: trade({ time_entries: rows }), permissions: ["time.read", "time.write"], projects: [JOB] })
  const own = await crew.run(() => realCostPlus.listProjectTimeEntries(JOB))
  assert.deepEqual(own.map((row) => row.id), [id(92)])
  assert.equal(JSON.stringify(crew.queries.filter((query) => query.table === "time_entries")).includes("approval_token_hash"), false)

  const office = createServiceHarness({ tables: trade({ time_entries: rows }), permissions: ["time.read", "time.manage"], projects: [JOB] })
  const all = await office.run(() => realCostPlus.listProjectTimeEntries(JOB))
  assert.equal(all.length, 2)
  assert.equal(JSON.stringify(office.queries.filter((query) => query.table === "time_entries")).includes("approval_token_hash"), false)
})

test("locked time that still awaits the client can be sent for approval without changing payroll's record", async () => {
  const locked = entry({ id: id(94), status: "locked", approved_by_pm_at: "2026-10-13T00:00:00Z" })
  const service = createServiceHarness({ tables: trade({ time_entries: [locked] }), permissions: ["bill.approve"], projects: [JOB] })
  const link = await service.run(() => realCostPlus.createTimeEntryApprovalLink(id(94)))
  assert.ok(link.token)
  assert.equal(service.db.time_entries[0].status, "locked")
  assert.ok(service.db.time_entries[0].approval_token_hash)
})

test("a job whose approval needs a cost code but budgets none offers the company's codes at the clock", async () => {
  const service = createServiceHarness({
    tables: trade({
      project_financial_settings: [{ org_id: ORG, project_id: JOB, cost_codes_enabled: true }],
      cost_codes: [{ id: CODE, org_id: ORG, code: "26-100", name: "Rough-in", is_active: true }],
    }),
    permissions: ["time.write"],
    projects: [JOB],
  })
  await assert.rejects(service.run(() => clockIn({ projectId: JOB })), /cost code/)
  const session = await service.run(() => clockIn({ projectId: JOB, costCodeId: CODE }))
  assert.equal(session.costCodeId, CODE)
})
