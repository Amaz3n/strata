require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
  ageInDays,
  buildWeek,
  daysBetween,
  formatMoney,
  rankDecisions,
  scoreProject,
} = require("../lib/control-tower/model")

const read = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8")

const MIGRATION = "supabase/migrations/20260903120000_control_tower_rollup.sql"
const SERVICE = "lib/services/control-tower.ts"
const TODAY = "2026-09-04"

/** A job with nothing wrong with it. Each case below changes one thing. */
function project(overrides = {}) {
  return {
    id: "p1",
    name: "Gates Residence",
    status: "active",
    start_date: "2026-02-15",
    end_date: "2026-12-01",
    contract_cents: null,
    client_name: "Isabella Costa",
    current_phase: null,
    next_milestone_name: null,
    next_milestone_type: null,
    next_milestone_date: null,
    sched_total: 20,
    sched_completed: 10,
    sched_open: 10,
    sched_at_risk: 0,
    sched_blocked: 0,
    sched_critical_behind: 0,
    sched_overdue: 0,
    sched_due_window: 0,
    tasks_open: 0,
    tasks_overdue: 0,
    tasks_due_window: 0,
    rfis_open: 0,
    rfis_overdue: 0,
    submittals_pending: 0,
    cos_pending: 0,
    cos_pending_cents: 0,
    punch_open: 0,
    punch_urgent: 0,
    closeout_missing: 0,
    ar_open_cents: 0,
    ar_overdue_cents: 0,
    ap_unpaid_cents: 0,
    ap_unpaid_count: 0,
    ap_pending_count: 0,
    ready_to_bill_cents: 0,
    budget_cents: 0,
    actual_cents: 0,
    poc_as_of: null,
    poc_percent_complete: null,
    poc_over_under_cents: null,
    ...overrides,
  }
}

function decision(overrides = {}) {
  return {
    kind: "change_order",
    id: "d1",
    project_id: "p1",
    project_name: "Gates Residence",
    title: "Lanai upgrade",
    reference: "3",
    created_at: "2026-09-01T12:00:00Z",
    due_date: null,
    cents: 100000,
    days: null,
    priority: null,
    ...overrides,
  }
}

/* ================================================================
 * The desk is one query
 * ============================================================== */

test("the control tower loads from a single rollup, not a fan-out", () => {
  const service = read(SERVICE)

  // The desk this replaced issued roughly thirty PostgREST calls in dependency
  // chains four deep, and nothing painted until the slowest one landed. The
  // guard is structural because the regression is: any band that starts reading
  // its own table again reintroduces exactly that waterfall.
  const rpcCalls = service.match(/\.rpc\(/g) ?? []
  assert.equal(rpcCalls.length, 1, "the desk must resolve through one rollup call")
  assert.match(service, /control_tower_rollup/)

  for (const table of [
    "projects",
    "schedule_items",
    "tasks",
    "invoices",
    "vendor_bills",
    "change_orders",
    "rfis",
    "submittals",
    "punch_items",
    "billable_costs",
    "poc_snapshots",
    "closeout_items",
  ]) {
    assert.doesNotMatch(
      service,
      new RegExp(`from\\("${table}"\\)`),
      `${table} is aggregated by control_tower_rollup; reading it here is the waterfall again`,
    )
  }

  // The two reads that legitimately travel beside it: compliance pressure is a
  // different question, and a name for a double-booked person is only fetched
  // when the week actually contains one.
  assert.match(service, /from\("compliance_documents"\)/)
  assert.match(service, /from\("app_users"\)/)
  assert.match(service, /if \(ids\.length === 0\) return new Map\(\)/)
})

test("the rollup is service-role only and takes an authorization scope", () => {
  const sql = read(MIGRATION)

  // It accepts an arbitrary org id, so grants protect it, not RLS.
  assert.match(sql, /revoke all on function public\.control_tower_rollup/)
  assert.match(sql, /grant execute on function public\.control_tower_rollup\([^)]*\)\s*\n?\s*to service_role/)
  assert.doesNotMatch(sql, /to authenticated/)

  // Division scope is a parameter the server supplies, and null means the whole
  // org. Flattening null to an empty list would silently blank the desk.
  assert.match(sql, /p_project_ids uuid\[\] default null/)
  assert.match(sql, /p_project_ids is null or p\.id = any \(p_project_ids\)/)
  assert.match(read(SERVICE), /getDivisionScopedProjectIds/)

  // Reporting-excluded jobs stay out of every number on the desk.
  assert.match(sql, /not p\.excluded_from_reporting/)
})

test("a failed rollup crashes rather than reporting an all-clear", () => {
  const service = read(SERVICE)
  assert.match(service, /throw new Error\(`Failed to load the control tower/)
  assert.match(service, /returned no payload/)
})

/* ================================================================
 * Project health
 * ============================================================== */

test("a job over budget is reported in dollars, not as a percentage", () => {
  const health = scoreProject(project({ budget_cents: 100000, actual_cents: 125000 }))
  const budget = health.signals.find((signal) => signal.key === "cost")

  assert.equal(budget.tone, "destructive")
  assert.match(budget.detail, /\$250 over budget/)
  assert.equal(health.overBudgetCents, 25000)
  assert.equal(health.budgetRatio, 1.25)
})

test("a job with no budget has no budget bar, rather than an empty one", () => {
  // A zeroed track reads as "0% spent", which is a claim the data cannot make.
  const health = scoreProject(project({ budget_cents: 0, actual_cents: 500000 }))
  assert.equal(health.budgetRatio, null)
  assert.equal(health.overBudgetCents, 500000)
  assert.equal(
    health.signals.find((signal) => signal.key === "cost"),
    undefined,
  )
})

test("critical-path work that has stopped outranks everything else on a job", () => {
  const critical = scoreProject(project({ sched_critical_behind: 1 }))
  const paperwork = scoreProject(project({ submittals_pending: 8, closeout_missing: 12 }))
  const overdueMoney = scoreProject(project({ ar_overdue_cents: 2_500_00 }))

  assert.ok(critical.score > paperwork.score)
  assert.ok(critical.score > overdueMoney.score)
  assert.equal(critical.worst.tone, "destructive")
  assert.match(critical.worst.detail, /critical-path item behind/)
})

test("every flagged job can say what is wrong with it", () => {
  // The watchlist this replaced ranked by an opaque score and showed no reason.
  const rows = [
    project({ sched_blocked: 2 }),
    project({ ar_overdue_cents: 900000 }),
    project({ rfis_overdue: 3 }),
    project({ budget_cents: 100000, actual_cents: 95000 }),
    project({ ready_to_bill_cents: 500000 }),
  ]
  for (const row of rows) {
    const health = scoreProject(row)
    assert.ok(health.score > 0)
    assert.ok(health.worst, "a scored job must carry the reason it scored")
    assert.ok(health.worst.detail.length > 0)
  }

  // And a clean job says nothing rather than inventing a signal.
  const clean = scoreProject(project())
  assert.equal(clean.worst, null)
  assert.equal(clean.signals.length, 0)
})

test("unbilled approved cost is reported when nothing is overdue", () => {
  const health = scoreProject(project({ ready_to_bill_cents: 1_200_00 }))
  const cash = health.signals.find((signal) => signal.key === "cash")
  assert.match(cash.detail, /not invoiced/)

  // Overdue money is the louder half of the same question, so it wins the slot.
  const overdue = scoreProject(
    project({ ready_to_bill_cents: 1_200_00, ar_overdue_cents: 6_000_00 }),
  )
  const cashOverdue = overdue.signals.find((signal) => signal.key === "cash")
  assert.equal(cashOverdue.tone, "destructive")
  assert.match(cashOverdue.detail, /overdue from the client/)
})

/* ================================================================
 * The decision queue
 * ============================================================== */

test("decisions rank on money and lateness together", () => {
  // The regression: severity buckets were assigned before the money was looked
  // at, so a $200k change order raised this morning sorted below a stale $500
  // one for no reason a builder would accept.
  const ranked = rankDecisions(
    [
      decision({ id: "small-old", cents: 50000, created_at: "2026-08-20T12:00:00Z" }),
      decision({ id: "large-new", cents: 20_000_000, created_at: "2026-09-04T09:00:00Z" }),
    ],
    TODAY,
  )
  assert.equal(ranked[0].id, "large-new")

  // Lateness still counts: past its due date, the small one comes back up.
  const withDueDate = rankDecisions(
    [
      decision({ id: "small-late", kind: "rfi", cents: 5000, due_date: "2026-07-01" }),
      decision({ id: "medium-fresh", cents: 800000, created_at: "2026-09-04T09:00:00Z" }),
    ],
    TODAY,
  )
  assert.equal(withDueDate[0].id, "small-late")
  assert.equal(withDueDate[0].overdueDays, daysBetween("2026-07-01", TODAY))
  assert.equal(withDueDate[0].severity, "urgent")
})

test("a decision links to the surface that decides it", () => {
  const ranked = rankDecisions(
    [
      decision({ id: "a", kind: "change_order" }),
      decision({ id: "b", kind: "rfi" }),
      decision({ id: "c", kind: "submittal" }),
      decision({ id: "d", kind: "vendor_bill" }),
      decision({ id: "e", kind: "punch_item" }),
    ],
    TODAY,
  )
  const hrefByKind = Object.fromEntries(ranked.map((item) => [item.kind, item.href]))
  assert.equal(hrefByKind.change_order, "/projects/p1/change-orders")
  assert.equal(hrefByKind.rfi, "/projects/p1/rfis")
  assert.equal(hrefByKind.submittal, "/projects/p1/submittals")
  assert.equal(hrefByKind.vendor_bill, "/projects/p1/payables")
  assert.equal(hrefByKind.punch_item, "/projects/p1/punch")

  // An item with no project still has somewhere to land.
  const orphan = rankDecisions([decision({ project_id: null })], TODAY)
  assert.equal(orphan[0].href, "/projects")
})

test("the queue is capped and says how many it left out", () => {
  const many = Array.from({ length: 30 }, (_, index) =>
    decision({ id: `d${index}`, cents: (index + 1) * 10000 }),
  )
  const ranked = rankDecisions(many, TODAY)
  assert.equal(ranked.length, 12)
  // Capped by consequence, not by whichever row the database returned first.
  assert.equal(ranked[0].id, "d29")

  const decisions = read("components/control-tower/control-tower-decisions.tsx")
  assert.match(decisions, /more are open/)
})

test("age is counted in whole days from the reader's today", () => {
  assert.equal(ageInDays("2026-09-04T09:00:00Z", TODAY), 0)
  assert.equal(ageInDays("2026-09-03T23:00:00Z", TODAY), 1)
  assert.equal(ageInDays("2026-08-25T12:00:00Z", TODAY), 10)
  // A timestamp in the future is not negative age.
  assert.equal(ageInDays("2026-10-01T00:00:00Z", TODAY), 0)
})

/* ================================================================
 * The week ahead
 * ============================================================== */

const week = (overrides = {}) => ({
  today: TODAY,
  window_days: 7,
  lookahead: { items: [], days: [], ...overrides },
})

test("the week covers the whole window, including its empty days", () => {
  const built = buildWeek(week())
  assert.equal(built.days.length, 7)
  assert.equal(built.days[0].label, "Today")
  assert.equal(built.days[1].label, "Tomorrow")
  assert.equal(built.days[0].isToday, true)
  assert.equal(built.days[6].key, "2026-09-10")
})

test("a trade booked across jobs on one day is reported as a collision", () => {
  const built = buildWeek(
    week({
      days: [
        {
          day: "2026-09-07",
          active_items: 3,
          project_count: 3,
          trade_overlaps: [{ trade: "framing", projects: 3 }],
          assignee_overlaps: [],
        },
      ],
    }),
  )
  const monday = built.days.find((day) => day.key === "2026-09-07")
  assert.equal(monday.collisions.length, 1)
  assert.equal(monday.collisions[0].tone, "destructive")
  assert.match(monday.collisions[0].title, /Framing on 3 jobs/)
  assert.equal(built.collisionCount, 1)
})

test("a double-booked person is named when the roster can name them", () => {
  const payload = week({
    days: [
      {
        day: "2026-09-07",
        active_items: 2,
        project_count: 2,
        trade_overlaps: [],
        assignee_overlaps: [{ assignee: "u1", projects: 2 }],
      },
    ],
  })

  const named = buildWeek(payload, new Map([["u1", "Dana Reyes"]]))
  assert.match(named.days.find((day) => day.key === "2026-09-07").collisions[0].title, /Dana Reyes/)

  // And still reports the collision when it cannot.
  const anonymous = buildWeek(payload)
  assert.match(
    anonymous.days.find((day) => day.key === "2026-09-07").collisions[0].title,
    /One person on 2 jobs/,
  )
})

test("a heavy field day is flagged on the day it lands", () => {
  const built = buildWeek(
    week({
      days: [
        {
          day: "2026-09-05",
          active_items: 14,
          project_count: 5,
          trade_overlaps: [],
          assignee_overlaps: [],
        },
      ],
    }),
  )
  const heavy = built.days.find((day) => day.key === "2026-09-05")
  assert.equal(heavy.collisions[0].tone, "destructive")
  assert.match(heavy.collisions[0].detail, /14 activities across 5 jobs/)
})

test("critical-path work leads its day", () => {
  const built = buildWeek(
    week({
      items: [
        {
          kind: "task_due",
          id: "t1",
          project_id: "p1",
          project_name: "Gates",
          title: "Order tile",
          date: "2026-09-05",
          item_type: null,
          trade: null,
          status: "todo",
          is_critical_path: false,
        },
        {
          kind: "schedule_finish",
          id: "s1",
          project_id: "p1",
          project_name: "Gates",
          title: "Roof dry-in",
          date: "2026-09-05",
          item_type: "milestone",
          trade: "roofing",
          status: "in_progress",
          is_critical_path: true,
        },
      ],
    }),
  )
  const day = built.days.find((entry) => entry.key === "2026-09-05")
  assert.equal(day.items[0].title, "Roof dry-in")
  assert.equal(built.totalItems, 2)
})

/* ================================================================
 * Money at the edge
 * ============================================================== */

test("money is formatted compactly and keeps its sign", () => {
  assert.equal(formatMoney(0), "$0")
  assert.equal(formatMoney(45_00), "$45")
  assert.equal(formatMoney(1_500_00), "$1.5K")
  assert.equal(formatMoney(67_650_00), "$68K")
  assert.equal(formatMoney(2_438_509_00), "$2.44M")
  assert.equal(formatMoney(-1_500_00), "−$1.5K")
})
