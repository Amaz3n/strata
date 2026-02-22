import type { SupabaseClient } from "@supabase/supabase-js"
import type {
  WeeklySnapshotDecisionItem,
  WeeklySnapshotDriftItem,
  WeeklySnapshotMetric,
  WeeklySnapshotWatchlistItem,
} from "@/lib/emails/weekly-executive-snapshot-email"

type SnapshotProject = {
  id: string
  name: string
}

type DecisionRow = WeeklySnapshotDecisionItem & { score: number }

type WatchlistRow = WeeklySnapshotWatchlistItem & { score: number; projectId: string }

export interface WeeklyExecutiveSnapshotPayload {
  weekLabel: string
  generatedAtLabel: string
  metrics: WeeklySnapshotMetric[]
  watchlist: WeeklySnapshotWatchlistItem[]
  decisions: WeeklySnapshotDecisionItem[]
  drift: WeeklySnapshotDriftItem[]
  executiveNotes: string[]
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(value)
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: "UTC",
  }).format(value)
}

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

function formatDelta(current: number, previous: number, unitSuffix = "") {
  const diff = current - previous
  const sign = diff > 0 ? "+" : ""
  return `${sign}${diff}${unitSuffix} vs prior 7d`
}

function formatDeltaCurrency(currentCents: number, previousCents: number) {
  const diff = currentCents - previousCents
  const abs = formatCents(Math.abs(diff))
  const sign = diff > 0 ? "+" : diff < 0 ? "-" : ""
  return `${sign}${abs} vs prior 7d`
}

function getUtcDateOnly(date: Date) {
  return date.toISOString().split("T")[0]
}

function getWeekStartUtc(date: Date) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = (copy.getUTCDay() + 6) % 7 // Monday=0
  copy.setUTCDate(copy.getUTCDate() - day)
  return copy
}

function daysSince(createdAt: string | null | undefined, asOf: Date) {
  if (!createdAt) return 0
  const created = new Date(createdAt)
  return Math.max(0, Math.floor((asOf.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)))
}

function dueLabelFromIso(dueDate: string | null | undefined) {
  if (!dueDate) return "ASAP"
  return formatDate(new Date(`${dueDate}T00:00:00.000Z`))
}

function toPairsKey(orgId: string, userId: string) {
  return `${orgId}::${userId}`
}

export function getWeeklySnapshotWeekStart(date: Date) {
  return getUtcDateOnly(getWeekStartUtc(date))
}

export async function buildWeeklyExecutiveSnapshotForOrg({
  supabase,
  orgId,
  asOf = new Date(),
}: {
  supabase: SupabaseClient
  orgId: string
  asOf?: Date
}): Promise<WeeklyExecutiveSnapshotPayload> {
  const asOfDay = getUtcDateOnly(asOf)
  const d7 = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000)
  const d14 = new Date(asOf.getTime() - 14 * 24 * 60 * 60 * 1000)
  const d30 = new Date(asOf.getTime() - 30 * 24 * 60 * 60 * 1000)

  const weekStart = getWeekStartUtc(asOf)
  const weekEnd = new Date(weekStart)
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6)

  const weekLabel = `Week of ${formatDate(weekStart)} - ${formatDate(weekEnd)}`
  const generatedAtLabel = `Generated ${formatDateTime(asOf)}`

  const { data: activeProjects, error: projectsError } = await supabase
    .from("projects")
    .select("id, name")
    .eq("org_id", orgId)
    .in("status", ["active", "planning", "on_hold"])

  if (projectsError) {
    throw new Error(`Failed to load projects for weekly snapshot: ${projectsError.message}`)
  }

  const projects = (activeProjects ?? []) as SnapshotProject[]
  const projectIds = projects.map((p) => p.id)
  const projectNameById = new Map(projects.map((p) => [p.id, p.name]))

  const [
    scheduleRiskRes,
    tasksRes,
    invoicesRes,
    pendingCOsRes,
    vendorBillsRes,
    rfisRes,
    submittalsRes,
    blockedTasksCountRes,
    rfisRecent7Res,
    rfisPrev7Res,
    completedRecentRes,
    completedPrevRes,
    createdRecentRes,
    createdPrevRes,
  ] = await Promise.all([
    projectIds.length > 0
      ? supabase
          .from("schedule_items")
          .select("project_id, status, is_critical_path")
          .in("project_id", projectIds)
          .in("status", ["at_risk", "blocked"])
      : Promise.resolve({ data: [] as any[], error: null }),
    projectIds.length > 0
      ? supabase
          .from("tasks")
          .select("project_id, status, due_date, created_at")
          .in("project_id", projectIds)
          .neq("status", "done")
      : Promise.resolve({ data: [] as any[], error: null }),
    projectIds.length > 0
      ? supabase
          .from("invoices")
          .select("project_id, status, due_date, balance_due_cents")
          .in("project_id", projectIds)
          .in("status", ["sent", "partial", "overdue"])
      : Promise.resolve({ data: [] as any[], error: null }),
    projectIds.length > 0
      ? supabase
          .from("change_orders")
          .select("project_id, title, total_cents, days_impact, created_at")
          .in("project_id", projectIds)
          .eq("status", "pending")
      : Promise.resolve({ data: [] as any[], error: null }),
    projectIds.length > 0
      ? supabase
          .from("vendor_bills")
          .select("project_id, status, bill_number, total_cents, created_at")
          .in("project_id", projectIds)
          .in("status", ["pending", "approved"])
      : Promise.resolve({ data: [] as any[], error: null }),
    projectIds.length > 0
      ? supabase
          .from("rfis")
          .select("project_id, subject, due_date, priority, cost_impact_cents, schedule_impact_days, created_at, assigned_to")
          .in("project_id", projectIds)
          .in("status", ["open", "pending"])
      : Promise.resolve({ data: [] as any[], error: null }),
    projectIds.length > 0
      ? supabase
          .from("submittals")
          .select("project_id, title, due_date, lead_time_days, created_at")
          .in("project_id", projectIds)
          .in("status", ["pending", "submitted", "revise_resubmit"])
      : Promise.resolve({ data: [] as any[], error: null }),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "blocked"),
    supabase
      .from("rfis")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .gte("created_at", d7.toISOString()),
    supabase
      .from("rfis")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .gte("created_at", d14.toISOString())
      .lt("created_at", d7.toISOString()),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "done")
      .gte("updated_at", d7.toISOString()),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "done")
      .gte("updated_at", d14.toISOString())
      .lt("updated_at", d7.toISOString()),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .gte("created_at", d7.toISOString()),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .gte("created_at", d14.toISOString())
      .lt("created_at", d7.toISOString()),
  ])

  const queryErrors = [
    scheduleRiskRes.error,
    tasksRes.error,
    invoicesRes.error,
    pendingCOsRes.error,
    vendorBillsRes.error,
    rfisRes.error,
    submittalsRes.error,
    blockedTasksCountRes.error,
    rfisRecent7Res.error,
    rfisPrev7Res.error,
    completedRecentRes.error,
    completedPrevRes.error,
    createdRecentRes.error,
    createdPrevRes.error,
  ].filter(Boolean)

  if (queryErrors.length > 0) {
    throw new Error(`Failed to load weekly snapshot data: ${queryErrors[0]?.message ?? "unknown error"}`)
  }

  const scheduleRiskRows = (scheduleRiskRes.data ?? []) as Array<{
    project_id: string | null
    status: string | null
    is_critical_path: boolean | null
  }>
  const openTaskRows = (tasksRes.data ?? []) as Array<{
    project_id: string | null
    status: string | null
    due_date: string | null
    created_at: string | null
  }>
  const invoiceRows = (invoicesRes.data ?? []) as Array<{
    project_id: string | null
    status: string | null
    due_date: string | null
    balance_due_cents: number | null
  }>
  const pendingCORows = (pendingCOsRes.data ?? []) as Array<{
    project_id: string | null
    title: string | null
    total_cents: number | null
    days_impact: number | null
    created_at: string | null
  }>
  const vendorBillRows = (vendorBillsRes.data ?? []) as Array<{
    project_id: string | null
    status: string | null
    bill_number: string | null
    total_cents: number | null
    created_at: string | null
  }>
  const rfiRows = (rfisRes.data ?? []) as Array<{
    project_id: string | null
    subject: string | null
    due_date: string | null
    priority: string | null
    cost_impact_cents: number | null
    schedule_impact_days: number | null
    created_at: string | null
    assigned_to: string | null
  }>
  const submittalRows = (submittalsRes.data ?? []) as Array<{
    project_id: string | null
    title: string | null
    due_date: string | null
    lead_time_days: number | null
    created_at: string | null
  }>

  const ar30Cents = invoiceRows.reduce((sum, inv) => {
    if (!inv.due_date) return sum
    if (inv.balance_due_cents == null || inv.balance_due_cents <= 0) return sum
    return inv.due_date < getUtcDateOnly(d30) ? sum + inv.balance_due_cents : sum
  }, 0)

  const pendingCOTotalCents = pendingCORows.reduce((sum, co) => sum + Math.abs(co.total_cents ?? 0), 0)

  const watchlistRows: WatchlistRow[] = projects
    .map((project) => {
      const pid = project.id
      const riskItems = scheduleRiskRows.filter((item) => item.project_id === pid)
      const criticalBehind = riskItems.filter((item) => item.is_critical_path).length
      const atRisk = riskItems.length
      const overdueTasks = openTaskRows.filter((task) => task.project_id === pid && task.due_date && task.due_date < asOfDay).length
      const projectRfis = rfiRows.filter((rfi) => rfi.project_id === pid)
      const overdueRfis = projectRfis.filter((rfi) => rfi.due_date && rfi.due_date < asOfDay).length
      const pendingSubs = submittalRows.filter((sub) => sub.project_id === pid).length

      const overdueAR = invoiceRows
        .filter((inv) => inv.project_id === pid && inv.due_date && inv.due_date < asOfDay)
        .reduce((sum, inv) => sum + Math.max(0, inv.balance_due_cents ?? 0), 0)

      const pendingBills = vendorBillRows.filter((bill) => bill.project_id === pid && bill.status === "pending")
      const pendingBillCents = pendingBills.reduce((sum, bill) => sum + (bill.total_cents ?? 0), 0)

      const projectCOs = pendingCORows.filter((co) => co.project_id === pid)
      const pendingCOCents = projectCOs.reduce((sum, co) => sum + Math.abs(co.total_cents ?? 0), 0)

      const score =
        criticalBehind * 4 +
        atRisk * 2 +
        overdueTasks +
        overdueRfis * 2 +
        (overdueAR > 0 ? 3 : 0) +
        (pendingBills.length > 0 ? 1 : 0) +
        (pendingCOCents > 0 ? 2 : 0) +
        (pendingSubs > 2 ? 1 : 0)

      if (score === 0) return null

      const schedule =
        criticalBehind > 0
          ? `${criticalBehind} critical path item${criticalBehind > 1 ? "s" : ""} behind`
          : atRisk + overdueTasks > 0
            ? `${atRisk + overdueTasks} items at risk or overdue`
            : "On track"

      const costParts: string[] = []
      if (overdueAR > 0) costParts.push(`${formatCents(overdueAR)} overdue AR`)
      if (pendingCOCents > 0) costParts.push(`${formatCents(pendingCOCents)} pending CO`)
      if (pendingBillCents > 0) costParts.push(`${formatCents(pendingBillCents)} pending bills`)
      const cost = costParts.length > 0 ? costParts.join(" + ") : "Healthy cash position"

      const docs =
        criticalBehind > 0 && projectCOs.length > 0
          ? `Approve ${projectCOs.length} CO${projectCOs.length > 1 ? "s" : ""} this week`
          : overdueRfis > 0
            ? `Resolve ${overdueRfis} overdue RFI${overdueRfis > 1 ? "s" : ""}`
            : pendingSubs > 0
              ? `Review ${pendingSubs} pending submittal${pendingSubs > 1 ? "s" : ""}`
              : "No immediate executive intervention"

      return {
        projectId: pid,
        projectName: project.name,
        schedule,
        cost,
        docs,
        score,
      }
    })
    .filter((item): item is WatchlistRow => Boolean(item))
    .sort((a, b) => b.score - a.score)

  const decisionRows: DecisionRow[] = [
    ...pendingCORows.map((co) => {
      const total = Math.abs(co.total_cents ?? 0)
      const age = daysSince(co.created_at, asOf)
      const impactLabel = `${formatCents(total)}${co.days_impact ? ` · ${co.days_impact}d impact` : ""}`
      return {
        typeLabel: "Change Order",
        title: co.title ?? "Pending change order",
        projectName: co.project_id ? (projectNameById.get(co.project_id) ?? undefined) : undefined,
        owner: "Precon + Ops",
        dueBy: age > 7 ? "ASAP" : "This week",
        ageLabel: `${age}d`,
        impactLabel,
        score: 80 + age + Math.min(30, Math.floor(total / 250_000)),
      }
    }),
    ...submittalRows.map((sub) => {
      const age = daysSince(sub.created_at, asOf)
      const dueBy = dueLabelFromIso(sub.due_date)
      const impactLabel = sub.lead_time_days ? `${sub.lead_time_days}d lead time` : "Pending review"
      return {
        typeLabel: "Submittal",
        title: sub.title ?? "Pending submittal",
        projectName: sub.project_id ? (projectNameById.get(sub.project_id) ?? undefined) : undefined,
        owner: "Project Lead",
        dueBy,
        ageLabel: `${age}d`,
        impactLabel,
        score: 55 + age + (sub.due_date && sub.due_date < asOfDay ? 25 : 0),
      }
    }),
    ...vendorBillRows
      .filter((bill) => bill.status === "pending")
      .map((bill) => {
        const age = daysSince(bill.created_at, asOf)
        const amount = bill.total_cents ?? 0
        return {
          typeLabel: "Vendor Bill",
          title: bill.bill_number ? `Bill #${bill.bill_number} awaiting approval` : "Vendor bill awaiting approval",
          projectName: bill.project_id ? (projectNameById.get(bill.project_id) ?? undefined) : undefined,
          owner: "Office Admin",
          dueBy: age > 10 ? "ASAP" : "This week",
          ageLabel: `${age}d`,
          impactLabel: formatCents(amount),
          score: 45 + age + Math.min(20, Math.floor(amount / 150_000)),
        }
      }),
    ...rfiRows
      .filter((rfi) => Boolean(rfi.due_date == null || rfi.due_date <= asOfDay))
      .map((rfi) => {
        const age = daysSince(rfi.created_at, asOf)
        const impactParts: string[] = []
        if ((rfi.schedule_impact_days ?? 0) > 0) impactParts.push(`${rfi.schedule_impact_days}d schedule`)
        if ((rfi.cost_impact_cents ?? 0) > 0) impactParts.push(formatCents(rfi.cost_impact_cents ?? 0))
        const impactLabel = impactParts.length > 0 ? impactParts.join(" · ") : "Awaiting response"
        return {
          typeLabel: "RFI",
          title: rfi.subject ?? "Open RFI",
          projectName: rfi.project_id ? (projectNameById.get(rfi.project_id) ?? undefined) : undefined,
          owner: "Project Team",
          dueBy: dueLabelFromIso(rfi.due_date),
          ageLabel: `${age}d`,
          impactLabel,
          score: 50 + age + (rfi.due_date && rfi.due_date < asOfDay ? 20 : 0),
        }
      }),
  ].sort((a, b) => b.score - a.score)

  const decisions = decisionRows.slice(0, 4).map(({ score, ...item }) => item)
  const decisionsTotal = decisionRows.length

  const blockersCurrent = (rfiRows.length) + (pendingCORows.length) + (blockedTasksCountRes.count ?? 0)
  const newBlockers7 = rfisRecent7Res.count ?? 0
  const newBlockersPrev7 = rfisPrev7Res.count ?? 0
  const blockersPrevious = Math.max(0, blockersCurrent - newBlockers7 + newBlockersPrev7)

  const overdueNow = openTaskRows.filter((task) => task.due_date && task.due_date < asOfDay).length
  const overduePrev = openTaskRows.filter((task) => task.due_date && task.due_date < getUtcDateOnly(d7)).length

  const completedRecent = completedRecentRes.count ?? 0
  const completedPrev = completedPrevRes.count ?? 0
  const createdRecent = createdRecentRes.count ?? 0
  const createdPrev = createdPrevRes.count ?? 0

  const drift: WeeklySnapshotDriftItem[] = [
    { label: "Blockers", current: String(blockersCurrent), delta: formatDelta(blockersCurrent, blockersPrevious) },
    { label: "Overdue Tasks", current: String(overdueNow), delta: formatDelta(overdueNow, overduePrev) },
    { label: "Completed Tasks", current: String(completedRecent), delta: formatDelta(completedRecent, completedPrev) },
    { label: "New Tasks", current: String(createdRecent), delta: formatDelta(createdRecent, createdPrev) },
  ]

  const metrics: WeeklySnapshotMetric[] = [
    { label: "Active Projects", value: String(projects.length) },
    { label: "Exec Attention", value: String(watchlistRows.length) },
    { label: "AR 30+ Days", value: formatCents(ar30Cents) },
    { label: "Pending CO Value", value: formatCents(pendingCOTotalCents) },
    { label: "Decisions This Week", value: String(decisionsTotal) },
  ]

  const topWatch = watchlistRows[0]
  const topDecision = decisions[0]
  const pendingBillsCents = vendorBillRows
    .filter((bill) => bill.status === "pending")
    .reduce((sum, bill) => sum + (bill.total_cents ?? 0), 0)

  const executiveNotes: string[] = []

  if (topWatch) {
    executiveNotes.push(
      `${topWatch.projectName} is highest portfolio risk this week: ${topWatch.schedule.toLowerCase()} and ${topWatch.cost.toLowerCase()}.`,
    )
  } else {
    executiveNotes.push("No projects are currently trending into high-risk territory; portfolio remains operationally stable.")
  }

  if (topDecision) {
    executiveNotes.push(
      `${decisionsTotal} decision item${decisionsTotal === 1 ? "" : "s"} are open. Highest urgency: ${topDecision.title}${topDecision.projectName ? ` (${topDecision.projectName})` : ""}.`,
    )
  } else {
    executiveNotes.push("Decision backlog is clear; no executive approvals are currently blocked.")
  }

  if (ar30Cents > 0 || pendingBillsCents > 0) {
    executiveNotes.push(
      `${formatCents(ar30Cents)} in AR aged 30+ days and ${formatCents(pendingBillsCents)} in pending AP approvals require active cash management this week.`,
    )
  } else {
    executiveNotes.push("Cash position is healthy this week with no material AR aging or AP approval backlog.")
  }

  return {
    weekLabel,
    generatedAtLabel,
    metrics,
    watchlist: watchlistRows.slice(0, 4).map(({ score, projectId, ...row }) => row),
    decisions,
    drift,
    executiveNotes,
  }
}

export function getEligibleWeeklySnapshotPairs({
  activeMemberships,
  enabledPrefs,
}: {
  activeMemberships: Array<{ org_id: string | null; user_id: string | null }>
  enabledPrefs: Array<{ org_id: string | null; user_id: string | null }>
}) {
  const activeKeys = new Set(
    activeMemberships
      .filter((row) => row.org_id && row.user_id)
      .map((row) => toPairsKey(row.org_id as string, row.user_id as string)),
  )

  return enabledPrefs.filter((pref) => {
    if (!pref.org_id || !pref.user_id) return false
    return activeKeys.has(toPairsKey(pref.org_id, pref.user_id))
  }) as Array<{ org_id: string; user_id: string }>
}
