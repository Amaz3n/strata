/**
 * The control tower's read model, and the pure math the desk ranks by.
 *
 * Everything here is a pure function of the `control_tower_rollup` payload plus
 * a clock. SQL aggregates; this file decides what is urgent, what is at risk,
 * and in what order a builder should look at it. Keeping the judgment out of
 * SQL is what makes it testable (`tests/control-tower.test.js`) and what lets
 * the thresholds move without a migration.
 */

export type Tone = "neutral" | "success" | "warning" | "destructive"

/* ------------------------------------------------------------------ *
 * Payload — the shape `control_tower_rollup` returns, verbatim.
 * ------------------------------------------------------------------ */

export interface RollupProjectRow {
  id: string
  name: string
  status: string
  start_date: string | null
  end_date: string | null
  contract_cents: number | null
  client_name: string | null
  current_phase: string | null
  next_milestone_name: string | null
  next_milestone_type: string | null
  next_milestone_date: string | null
  sched_total: number
  sched_completed: number
  sched_open: number
  sched_at_risk: number
  sched_blocked: number
  sched_critical_behind: number
  sched_overdue: number
  sched_due_window: number
  tasks_open: number
  tasks_overdue: number
  tasks_due_window: number
  rfis_open: number
  rfis_overdue: number
  submittals_pending: number
  cos_pending: number
  cos_pending_cents: number
  punch_open: number
  punch_urgent: number
  closeout_missing: number
  ar_open_cents: number
  ar_overdue_cents: number
  ap_unpaid_cents: number
  ap_unpaid_count: number
  ap_pending_count: number
  ready_to_bill_cents: number
  budget_cents: number
  actual_cents: number
  poc_as_of: string | null
  poc_percent_complete: number | null
  poc_over_under_cents: number | null
}

export type DecisionKind =
  | "change_order"
  | "rfi"
  | "submittal"
  | "vendor_bill"
  | "punch_item"

export interface RollupDecisionRow {
  kind: DecisionKind
  id: string
  project_id: string | null
  project_name: string | null
  title: string | null
  reference: string | null
  created_at: string
  due_date: string | null
  cents: number | null
  days: number | null
  priority: string | null
}

export interface RollupLookaheadItem {
  kind: "schedule_start" | "schedule_finish" | "task_due"
  id: string
  project_id: string | null
  project_name: string | null
  title: string | null
  date: string
  item_type: string | null
  trade: string | null
  status: string | null
  is_critical_path: boolean
}

export interface RollupDayStat {
  day: string
  active_items: number
  project_count: number
  trade_overlaps: Array<{ trade: string; projects: number }>
  assignee_overlaps: Array<{ assignee: string; projects: number }>
}

export interface ControlTowerRollup {
  today: string
  window_days: number
  projects_by_status: Record<string, number>
  counts: {
    active_projects: number
    tasks_due_window: number
    tasks_overdue: number
    sched_due_window: number
    sched_overdue: number
    cos_pending: number
    rfis_open: number
    submittals_pending: number
    bills_pending: number
    punch_open: number
    punch_urgent: number
  }
  money: {
    invoice_rollup: {
      total_invoiced: number
      total_collected: number
      total_overdue: number
      ar_aging: {
        current: number
        no_due_date: number
        one_to_thirty: number
        thirty_one_to_sixty: number
        sixty_one_to_ninety: number
        over_ninety: number
      }
    }
    unpaid_bills_cents: number
    unpaid_bills_count: number
    pending_bills_cents: number
    pending_bills_count: number
    ready_to_bill_cents: number
    ready_to_bill_projects: number
  }
  overdue_invoices: Array<{
    id: string
    invoice_number: string | null
    project_id: string | null
    project_name: string | null
    balance_cents: number
    due_date: string | null
    days_overdue: number
  }>
  wip: {
    as_of: string | null
    project_count: number
    net_cents: number
    over_billed_cents: number
    under_billed_cents: number
    most_under_billed: Array<{
      project_id: string
      project_name: string
      over_under_cents: number
      percent_complete: number
    }>
  }
  projects: RollupProjectRow[]
  decisions: RollupDecisionRow[]
  lookahead: {
    items: RollupLookaheadItem[]
    days: RollupDayStat[]
  }
}

/* ------------------------------------------------------------------ *
 * Dates. Rollup dates are date-only strings; parsing one through `Date`
 * yields UTC midnight and renders a day early west of Greenwich.
 * ------------------------------------------------------------------ */

const MS_PER_DAY = 86_400_000

export function parseDateOnly(iso: string): number {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number)
  return Date.UTC(year, (month ?? 1) - 1, day ?? 1)
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseDateOnly(toIso) - parseDateOnly(fromIso)) / MS_PER_DAY)
}

/**
 * How many calendar days old something is, floored at zero.
 *
 * Calendar days, not elapsed hours: a bill entered at 11pm last night is "1d
 * old" to the person reading the queue this morning, and elapsed-time rounding
 * calls that zero.
 */
export function ageInDays(createdAt: string, todayIso: string): number {
  const created = Date.parse(createdAt)
  if (Number.isNaN(created)) return 0
  return Math.max(0, daysBetween(new Date(created).toISOString(), todayIso))
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function shortDate(iso: string | null): string {
  if (!iso) return "—"
  const [, month, day] = iso.slice(0, 10).split("-")
  const label = MONTHS[Number(month) - 1]
  return label ? `${label} ${Number(day)}` : iso
}

export function dayLabel(iso: string, todayIso: string): string {
  const offset = daysBetween(todayIso, iso)
  if (offset === 0) return "Today"
  if (offset === 1) return "Tomorrow"
  const date = new Date(parseDateOnly(iso))
  return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
}

/* ------------------------------------------------------------------ *
 * Project health.
 *
 * A signal is a named reason a job needs attention, so the row can say WHY
 * rather than only how much. The score orders the table; the signals are what
 * the reader acts on. Both come from the same facts, so a high score can
 * always be explained by the chips beside it.
 * ------------------------------------------------------------------ */

export type SignalKey = "schedule" | "cost" | "cash" | "docs"

export interface ProjectSignal {
  key: SignalKey
  label: string
  tone: "warning" | "destructive"
  detail: string
}

export interface ProjectHealth {
  score: number
  signals: ProjectSignal[]
  /** The single worst signal, for the one-line explanation on a row. */
  worst: ProjectSignal | null
  /** budget spend as 0–1, or null where the job has no budget to spend against. */
  budgetRatio: number | null
  /** Schedule completion as 0–1, or null where nothing is scheduled. */
  scheduleRatio: number | null
  overBudgetCents: number
}

/**
 * Weights are ordered by what actually costs a builder money. Critical-path
 * work that has stopped is the most expensive thing on a job, overdue money is
 * next, and paperwork accumulates rather than bites.
 */
const WEIGHT = {
  criticalBehind: 12,
  blocked: 8,
  atRisk: 4,
  scheduleOverdue: 1.5,
  tasksOverdue: 1,
  rfiOverdue: 3,
  overBudget: 15,
  nearBudget: 5,
  arOverdue: 6,
  /** Full weight at $10k unbilled: real, and never louder than a stopped job. */
  unbilled: 3,
  pendingCo: 2,
  closeoutMissing: 0.5,
  punchUrgent: 2,
} as const

export function scoreProject(row: RollupProjectRow): ProjectHealth {
  const signals: ProjectSignal[] = []
  let score = 0

  const budgetRatio = row.budget_cents > 0 ? row.actual_cents / row.budget_cents : null
  const overBudgetCents = Math.max(0, row.actual_cents - row.budget_cents)
  const scheduleRatio = row.sched_total > 0 ? row.sched_completed / row.sched_total : null

  // --- Schedule ---
  score +=
    row.sched_critical_behind * WEIGHT.criticalBehind +
    row.sched_blocked * WEIGHT.blocked +
    row.sched_at_risk * WEIGHT.atRisk +
    Math.min(row.sched_overdue, 20) * WEIGHT.scheduleOverdue +
    Math.min(row.tasks_overdue, 20) * WEIGHT.tasksOverdue

  if (row.sched_critical_behind > 0) {
    signals.push({
      key: "schedule",
      label: "Schedule",
      tone: "destructive",
      detail: `${row.sched_critical_behind} critical-path item${row.sched_critical_behind === 1 ? "" : "s"} behind`,
    })
  } else if (row.sched_blocked > 0) {
    signals.push({
      key: "schedule",
      label: "Schedule",
      tone: "destructive",
      detail: `${row.sched_blocked} blocked`,
    })
  } else if (row.sched_at_risk > 0 || row.sched_overdue > 2) {
    const late = row.sched_at_risk + row.sched_overdue
    signals.push({
      key: "schedule",
      label: "Schedule",
      tone: "warning",
      detail: `${late} item${late === 1 ? "" : "s"} late or at risk`,
    })
  }

  // --- Cost ---
  if (budgetRatio !== null && budgetRatio >= 1) {
    score += WEIGHT.overBudget
    signals.push({
      key: "cost",
      label: "Budget",
      tone: "destructive",
      detail: `${formatMoney(overBudgetCents)} over budget`,
    })
  } else if (budgetRatio !== null && budgetRatio >= 0.9) {
    score += WEIGHT.nearBudget
    signals.push({
      key: "cost",
      label: "Budget",
      tone: "warning",
      detail: `${Math.round(budgetRatio * 100)}% of budget spent`,
    })
  }
  score += Math.min(row.cos_pending, 6) * WEIGHT.pendingCo

  // --- Cash ---
  if (row.ar_overdue_cents > 0) {
    score += WEIGHT.arOverdue
    signals.push({
      key: "cash",
      label: "Cash",
      tone: row.ar_overdue_cents >= 5_000_00 ? "destructive" : "warning",
      detail: `${formatMoney(row.ar_overdue_cents)} overdue from the client`,
    })
  } else if (row.ready_to_bill_cents >= 1_000_00) {
    // Earned work nobody has invoiced is cash sitting on a jobsite, so it lifts
    // a job up the list — by a little, on a curve that flattens at $10k.
    score += Math.min(row.ready_to_bill_cents / 10_000_00, 1) * WEIGHT.unbilled
    signals.push({
      key: "cash",
      label: "Unbilled",
      tone: "warning",
      detail: `${formatMoney(row.ready_to_bill_cents)} of approved cost not invoiced`,
    })
  }

  // --- Docs ---
  score +=
    row.rfis_overdue * WEIGHT.rfiOverdue +
    Math.min(row.closeout_missing, 20) * WEIGHT.closeoutMissing +
    row.punch_urgent * WEIGHT.punchUrgent

  if (row.rfis_overdue > 0) {
    signals.push({
      key: "docs",
      label: "RFIs",
      tone: "destructive",
      detail: `${row.rfis_overdue} RFI${row.rfis_overdue === 1 ? "" : "s"} past due`,
    })
  } else if (row.submittals_pending > 3) {
    signals.push({
      key: "docs",
      label: "Submittals",
      tone: "warning",
      detail: `${row.submittals_pending} awaiting review`,
    })
  }

  const rank = (signal: ProjectSignal) => (signal.tone === "destructive" ? 0 : 1)
  const worst = [...signals].sort((a, b) => rank(a) - rank(b))[0] ?? null

  return {
    score: Math.round(score),
    signals,
    worst,
    budgetRatio,
    scheduleRatio,
    overBudgetCents,
  }
}

export interface ScoredProject extends RollupProjectRow {
  health: ProjectHealth
}

export function scoreProjects(rows: RollupProjectRow[]): ScoredProject[] {
  return rows.map((row) => ({ ...row, health: scoreProject(row) }))
}

/* ------------------------------------------------------------------ *
 * The decision queue.
 * ------------------------------------------------------------------ */

export interface RankedDecision {
  kind: DecisionKind
  id: string
  typeLabel: string
  title: string
  projectId: string | null
  projectName: string | null
  href: string
  ageDays: number
  /** Days past due; 0 when not overdue or undated. */
  overdueDays: number
  impactCents: number | null
  impactDays: number | null
  severity: "urgent" | "waiting" | "queued"
  score: number
}

const DECISION_LABEL: Record<DecisionKind, string> = {
  change_order: "Change order",
  rfi: "RFI",
  submittal: "Submittal",
  vendor_bill: "Bill",
  punch_item: "Punch",
}

function decisionHref(row: RollupDecisionRow): string {
  if (!row.project_id) return "/projects"
  const base = `/projects/${row.project_id}`
  switch (row.kind) {
    case "change_order":
      return `${base}/change-orders`
    case "rfi":
      return `${base}/rfis`
    case "submittal":
      return `${base}/submittals`
    case "vendor_bill":
      return `${base}/payables`
    case "punch_item":
      return `${base}/punch`
  }
}

/**
 * Ranked by consequence, not by which query returned it.
 *
 * Money and lateness both count, and neither alone decides: a $200k change
 * order signed off today outranks a week-old $500 one, and a two-week-old RFI
 * blocking a trade outranks a fresh bill. The old queue sorted on severity
 * bucket then age, which pushed every large, recent decision below every small,
 * stale one.
 */
export function rankDecisions(
  rows: RollupDecisionRow[],
  todayIso: string,
  limit = 12,
): RankedDecision[] {
  const ranked = rows.map((row): RankedDecision => {
    const ageDays = ageInDays(row.created_at, todayIso)
    const overdueDays = row.due_date ? Math.max(0, daysBetween(row.due_date, todayIso)) : 0
    const impactCents = row.cents && row.cents !== 0 ? Math.abs(row.cents) : null
    const urgentPriority = row.priority === "urgent" || row.priority === "high"

    // Dollars are scored on a log scale so a $2M item cannot bury everything
    // else, and a $2k one still counts for something.
    const moneyScore = impactCents ? Math.log10(impactCents / 100 + 1) * 6 : 0
    const score =
      moneyScore +
      overdueDays * 2.5 +
      Math.min(ageDays, 45) * 0.6 +
      (urgentPriority ? 12 : 0) +
      (row.days && row.days > 0 ? Math.min(row.days, 30) * 0.8 : 0)

    const severity: RankedDecision["severity"] =
      overdueDays > 0 || urgentPriority || ageDays > 14
        ? "urgent"
        : ageDays > 5 || (impactCents ?? 0) >= 10_000_00
          ? "waiting"
          : "queued"

    return {
      kind: row.kind,
      id: row.id,
      typeLabel: DECISION_LABEL[row.kind],
      title: row.title?.trim() || DECISION_LABEL[row.kind],
      projectId: row.project_id,
      projectName: row.project_name,
      href: decisionHref(row),
      ageDays,
      overdueDays,
      impactCents,
      impactDays: row.days && row.days > 0 ? row.days : null,
      severity,
      score: Math.round(score * 10) / 10,
    }
  })

  return ranked.sort((a, b) => b.score - a.score || a.ageDays - b.ageDays).slice(0, limit)
}

/* ------------------------------------------------------------------ *
 * The week ahead.
 * ------------------------------------------------------------------ */

export interface WeekCollision {
  id: string
  title: string
  detail: string
  tone: "warning" | "destructive"
}

export interface WeekDay {
  key: string
  label: string
  isToday: boolean
  activeItems: number
  projectCount: number
  items: RollupLookaheadItem[]
  collisions: WeekCollision[]
}

export interface WeekAhead {
  days: WeekDay[]
  totalItems: number
  collisionCount: number
  busiestDay: WeekDay | null
}

/** A day carrying this many concurrent activities is one nobody can supervise. */
const HEAVY_DAY_ITEMS = 8

export function buildWeek(
  rollup: Pick<ControlTowerRollup, "lookahead" | "today" | "window_days">,
  nameByAssignee: Map<string, string> = new Map(),
): WeekAhead {
  const statByDay = new Map(rollup.lookahead.days.map((day) => [day.day.slice(0, 10), day]))
  const itemsByDay = new Map<string, RollupLookaheadItem[]>()
  for (const item of rollup.lookahead.items) {
    const key = item.date.slice(0, 10)
    const bucket = itemsByDay.get(key)
    if (bucket) bucket.push(item)
    else itemsByDay.set(key, [item])
  }

  const days: WeekDay[] = []
  for (let offset = 0; offset < rollup.window_days; offset += 1) {
    const key = new Date(parseDateOnly(rollup.today) + offset * MS_PER_DAY)
      .toISOString()
      .slice(0, 10)
    const stat = statByDay.get(key)
    const collisions: WeekCollision[] = []

    if ((stat?.active_items ?? 0) >= HEAVY_DAY_ITEMS) {
      collisions.push({
        id: `${key}:heavy`,
        title: "Heavy field day",
        detail: `${stat!.active_items} activities across ${stat!.project_count} job${stat!.project_count === 1 ? "" : "s"}`,
        tone: stat!.active_items >= HEAVY_DAY_ITEMS * 1.5 ? "destructive" : "warning",
      })
    }
    for (const overlap of stat?.trade_overlaps ?? []) {
      collisions.push({
        id: `${key}:trade:${overlap.trade}`,
        title: `${humanize(overlap.trade)} on ${overlap.projects} jobs`,
        detail: "Same trade booked across jobs on one day",
        tone: overlap.projects >= 3 ? "destructive" : "warning",
      })
    }
    for (const overlap of stat?.assignee_overlaps ?? []) {
      collisions.push({
        id: `${key}:assignee:${overlap.assignee}`,
        title: `${nameByAssignee.get(overlap.assignee) ?? "One person"} on ${overlap.projects} jobs`,
        detail: "Same person assigned across jobs on one day",
        tone: "destructive",
      })
    }

    const items = (itemsByDay.get(key) ?? []).sort(
      (a, b) =>
        Number(b.is_critical_path) - Number(a.is_critical_path) ||
        priorityOfKind(a) - priorityOfKind(b) ||
        (a.title ?? "").localeCompare(b.title ?? ""),
    )

    days.push({
      key,
      label: dayLabel(key, rollup.today),
      isToday: offset === 0,
      activeItems: stat?.active_items ?? 0,
      projectCount: stat?.project_count ?? 0,
      items,
      collisions: collisions.sort(
        (a, b) => (a.tone === "destructive" ? 0 : 1) - (b.tone === "destructive" ? 0 : 1),
      ),
    })
  }

  const busiestDay = [...days].sort((a, b) => b.activeItems - a.activeItems)[0] ?? null
  return {
    days,
    totalItems: rollup.lookahead.items.length,
    collisionCount: days.reduce((sum, day) => sum + day.collisions.length, 0),
    busiestDay: busiestDay && busiestDay.activeItems > 0 ? busiestDay : null,
  }
}

function priorityOfKind(item: RollupLookaheadItem): number {
  if (item.kind === "schedule_finish") return 0
  if (item.kind === "schedule_start") return 1
  return 2
}

export function humanize(value: string | null | undefined): string {
  if (!value) return ""
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
}

/* ------------------------------------------------------------------ *
 * Money formatting. Compact at the edge, integer cents everywhere else.
 * ------------------------------------------------------------------ */

export function formatMoney(cents: number): string {
  const negative = cents < 0
  const dollars = Math.abs(cents) / 100
  let body: string
  if (dollars >= 1_000_000) {
    const millions = dollars / 1_000_000
    body = `$${(millions >= 10 ? millions.toFixed(1) : millions.toFixed(2)).replace(/\.?0+$/, "")}M`
  } else if (dollars >= 10_000) {
    body = `$${Math.round(dollars / 1_000)}K`
  } else if (dollars >= 1_000) {
    body = `$${(dollars / 1_000).toFixed(1).replace(/\.0$/, "")}K`
  } else {
    body = `$${Math.round(dollars).toLocaleString("en-US")}`
  }
  return negative ? `−${body}` : body
}
