import { formatMoneyCents, formatPercent } from "@/lib/reports/format"
import { periodRange, todayIso } from "@/lib/reports/params"
import type { ReportColumn, ReportDefinition, ReportParamSpec, ReportParams } from "@/lib/reports/types"
import { describeMarginCohort, type MarginCohort, type MarginRollup } from "@/lib/financials/margin-rollup"
import { getBacklogReport } from "@/lib/services/closings"
import { getLandSupplyReport } from "@/lib/services/community-portfolio"
import { getCycleTimeReport, getEvenFlowAdherence } from "@/lib/services/even-flow"
import { getProductionPortfolioReport } from "@/lib/services/production-reporting"
import { getVarianceAnalysis, type VarianceDimension } from "@/lib/services/reports/variance-analysis"

/**
 * Production reports are gated on whether the org actually has communities, not
 * on `product_tier`. A mixed org running one 40-lot community gets its community
 * P&L even though the org is filed as residential.
 */
const needsCommunities = (ctx: { hasCommunities: boolean }) => ctx.hasCommunities

/** Which homes a margin report counts: every home, or the ones that closed or started in a period. */
const COHORT_PARAMS: ReportParamSpec[] = [
  {
    key: "cohort",
    kind: "select",
    label: "Homes counted",
    options: [
      { value: "all", label: "Every home in scope" },
      { value: "closed", label: "Closed in period" },
      { value: "started", label: "Started in period" },
    ],
  },
  { key: "period", kind: "period", label: "Period" },
]

function cohortFromParams(params: ReportParams): MarginCohort {
  if (params.cohort !== "closed" && params.cohort !== "started") return { kind: "all" }
  const range = periodRange(params.period ?? "ytd")
  return { kind: params.cohort, from: range.from, to: range.to }
}

/** Columns every margin rollup carries: revised margin beside the margin locked at release (else sale). */
const ROLLUP_COLUMNS: ReportColumn[] = [
  { key: "homes", header: "Homes", type: "number" },
  { key: "revenue", header: "Revenue", type: "money" },
  { key: "cost", header: "Revised cost", type: "money" },
  { key: "margin", header: "Margin", type: "money" },
  { key: "margin_percent", header: "Margin %", type: "percent" },
  { key: "original_margin", header: "Original margin", type: "money" },
  { key: "original_margin_percent", header: "Original %", type: "percent" },
  { key: "drift", header: "Drift", type: "money" },
  { key: "unbaselined", header: "No baseline", type: "number" },
]

function rollupCells(row: MarginRollup) {
  const baselined = row.baselinedHomes > 0
  return {
    homes: row.homes,
    revenue: row.revenueCents,
    cost: row.projectedCostCents,
    margin: row.marginCents,
    margin_percent: row.marginPercent,
    original_margin: baselined ? row.originalMarginCents : null,
    original_margin_percent: row.originalMarginPercent,
    drift: baselined ? { value: row.driftCents, tone: row.driftCents < 0 ? ("negative" as const) : row.driftCents > 0 ? ("positive" as const) : undefined } : null,
    unbaselined: row.unbaselinedHomes,
  }
}

const BASELINE_NOTE = "Original margin is the baseline locked at release (else at sale) and never moves; revised cost is today's approved budget plus approved variance orders, or posted cost once higher. Drift compares those two over the homes that have a baseline."

const communityPnl: ReportDefinition = {
  slug: "community-pnl",
  title: "Community P&L",
  summary: "Closed revenue, backlog, direct cost, VPO leakage, and projected margin for every community.",
  group: "production",
  scopes: ["org"],
  permissions: ["report.read", "financials.margin.read"],
  available: needsCommunities,
  ambientScope: "full",
  params: COHORT_PARAMS,
  run: async (ctx) => {
    const report = await getProductionPortfolioReport({ divisionId: ctx.divisionId, communityId: ctx.communityId, cohort: cohortFromParams(ctx.params) })
    const totals = report.totals

    return {
      subtitle: describeMarginCohort(report.cohort),
      notice: report.marginRestricted ? { tone: "warning", message: "Margin requires the margin permission." } : { tone: "info", message: BASELINE_NOTE },
      stats: [
        { key: "revenue", label: "Revenue", value: formatMoneyCents(totals.revenueCents) },
        { key: "closed", label: "Closed", value: formatMoneyCents(totals.closedRevenueCents) },
        { key: "backlog", label: "Backlog", value: formatMoneyCents(totals.backlogRevenueCents) },
        { key: "vpo", label: "VPO leakage", value: formatMoneyCents(totals.vpoCents), tone: totals.vpoCents > 0 ? "warning" : undefined },
        {
          key: "margin",
          label: "Projected margin",
          value: formatMoneyCents(totals.marginCents),
          detail: formatPercent(totals.marginPercent),
          tone: totals.marginCents < 0 ? "negative" : "positive",
        },
      ],
      tables: [
        {
          key: "communities",
          columns: [
            { key: "community", header: "Community" },
            { key: "community_id", header: "community_id", exportOnly: true },
            { key: "lots", header: "Homes", type: "number" },
            { key: "revenue", header: "Revenue", type: "money" },
            { key: "closed", header: "Closed", type: "money" },
            { key: "backlog", header: "Backlog", type: "money" },
            { key: "cost", header: "Direct cost", type: "money" },
            { key: "vpo", header: "VPO", type: "money" },
            { key: "margin", header: "Margin", type: "money" },
            { key: "margin_percent", header: "Margin %", type: "percent" },
            { key: "original_margin_percent", header: "Original %", type: "percent" },
            { key: "drift", header: "Drift", type: "money" },
            { key: "unbaselined", header: "No baseline", type: "number" },
            { key: "target_margin_percent", header: "target_margin_percent", exportOnly: true },
          ],
          rows: report.communities.map((row) => {
            const belowTarget =
              row.targetMarginPercent !== null && row.projectedMarginPercent < row.targetMarginPercent
            return {
              key: row.communityId,
              href: `/communities/${row.communityId}/pnl`,
              cells: {
                community: row.communityName,
                community_id: row.communityId,
                lots: row.lotCount,
                revenue: row.revenueCents,
                closed: row.closedRevenueCents,
                backlog: row.backlogRevenueCents,
                cost: Math.max(row.actualCostCents, row.budgetCents),
                vpo: row.vpoCents,
                margin: row.projectedMarginCents,
                margin_percent: {
                  value: row.projectedMarginPercent,
                  label: formatPercent(row.projectedMarginPercent),
                  tone: belowTarget ? "warning" : undefined,
                },
                // Locked at sale and release; the drift from it is the variance.
                original_margin_percent: row.originalMarginPercent,
                drift: row.originalMarginHomes > 0 ? row.driftCents : null,
                unbaselined: row.unbaselinedHomes,
                target_margin_percent: row.targetMarginPercent,
              },
            }
          }),
          totals: {
            community: `${report.communities.length} communit${report.communities.length === 1 ? "y" : "ies"}`,
            revenue: totals.revenueCents,
            closed: totals.closedRevenueCents,
            backlog: totals.backlogRevenueCents,
            cost: Math.max(totals.actualCostCents, totals.budgetCents),
            vpo: totals.vpoCents,
            margin: totals.marginCents,
            margin_percent: totals.marginPercent,
            drift: report.rollup.baselinedHomes > 0 ? report.rollup.driftCents : null,
            unbaselined: report.rollup.unbaselinedHomes,
          },
          emptyMessage: "No active communities in this scope.",
        },
      ],
    }
  },
}

const marginByPlan: ReportDefinition = {
  slug: "margin-by-plan",
  title: "Margin by Plan",
  summary: "Margin per house plan and plan version across every community, revised against the margin each home was locked at — which product is actually carrying the division.",
  group: "production",
  scopes: ["org"],
  permissions: ["report.read", "financials.margin.read"],
  available: needsCommunities,
  ambientScope: "full",
  params: COHORT_PARAMS,
  run: async (ctx) => {
    const report = await getProductionPortfolioReport({ divisionId: ctx.divisionId, communityId: ctx.communityId, cohort: cohortFromParams(ctx.params) })
    const homes = report.rollup.homes
    const margin = report.totals.marginCents
    const revenue = report.totals.revenueCents

    return {
      subtitle: describeMarginCohort(report.cohort),
      notice: report.marginRestricted ? { tone: "warning", message: "Margin requires the margin permission." } : { tone: "info", message: BASELINE_NOTE },
      stats: [
        { key: "plans", label: "Plans building", value: String(report.plans.filter((row) => row.planId).length) },
        { key: "homes", label: "Homes", value: String(homes) },
        { key: "revenue", label: "Revenue", value: formatMoneyCents(revenue) },
        {
          key: "margin",
          label: "Margin",
          value: formatMoneyCents(margin),
          detail: revenue > 0 ? formatPercent((margin / revenue) * 100) : undefined,
          tone: margin < 0 ? "negative" : "positive",
        },
      ],
      tables: [
        {
          key: "plans",
          title: "By plan",
          columns: [{ key: "plan", header: "Plan" }, { key: "plan_id", header: "plan_id", exportOnly: true }, ...ROLLUP_COLUMNS],
          rows: report.plans.map((row) => ({
            key: row.planId ?? "unassigned",
            href: row.planId ? `/plans/${row.planId}` : undefined,
            cells: { plan: row.planName, plan_id: row.planId, ...rollupCells(row) },
          })),
          totals: { plan: `${report.plans.length} plan${report.plans.length === 1 ? "" : "s"}`, ...rollupCells(report.rollup) },
          emptyMessage: "No homes in this cohort.",
        },
        {
          key: "plan_versions",
          title: "By plan version",
          columns: [
            { key: "plan", header: "Plan" },
            { key: "version", header: "Version", type: "number" },
            { key: "plan_version_id", header: "plan_version_id", exportOnly: true },
            ...ROLLUP_COLUMNS,
          ],
          rows: report.planVersions.map((row) => ({
            key: row.planVersionId ?? "unassigned",
            href: row.planId ? `/plans/${row.planId}` : undefined,
            cells: { plan: row.planName, version: row.versionNumber, plan_version_id: row.planVersionId, ...rollupCells(row) },
          })),
          emptyMessage: "No homes in this cohort.",
        },
      ],
    }
  },
}

const marginByDivision: ReportDefinition = {
  slug: "margin-by-division",
  title: "Margin by Division",
  summary: "Margin per division, revised against the margin each home was locked at, over an explicit cohort of homes.",
  group: "production",
  scopes: ["org"],
  permissions: ["report.read", "financials.margin.read"],
  available: needsCommunities,
  ambientScope: "full",
  params: COHORT_PARAMS,
  run: async (ctx) => {
    const report = await getProductionPortfolioReport({ divisionId: ctx.divisionId, communityId: ctx.communityId, cohort: cohortFromParams(ctx.params) })
    const totals = report.totals

    return {
      subtitle: describeMarginCohort(report.cohort),
      notice: report.marginRestricted ? { tone: "warning", message: "Margin requires the margin permission." } : { tone: "info", message: BASELINE_NOTE },
      stats: [
        { key: "homes", label: "Homes", value: String(report.rollup.homes) },
        { key: "revenue", label: "Revenue", value: formatMoneyCents(totals.revenueCents) },
        { key: "margin", label: "Margin", value: formatMoneyCents(totals.marginCents), detail: formatPercent(totals.marginPercent), tone: totals.marginCents < 0 ? "negative" : "positive" },
      ],
      tables: [
        {
          key: "divisions",
          columns: [{ key: "division", header: "Division" }, { key: "division_id", header: "division_id", exportOnly: true }, ...ROLLUP_COLUMNS],
          rows: report.divisions.map((row) => ({
            key: row.divisionId ?? "none",
            cells: { division: row.divisionName, division_id: row.divisionId, ...rollupCells(row) },
          })),
          totals: { division: `${report.divisions.length} division${report.divisions.length === 1 ? "" : "s"}`, ...rollupCells(report.rollup) },
          emptyMessage: "No homes in this cohort.",
        },
      ],
    }
  },
}

const vpoLeakage: ReportDefinition = {
  slug: "vpo-leakage",
  title: "Variance Leakage",
  summary: "Approved variance purchase orders grouped by reason and trade — where the budget is quietly bleeding.",
  group: "production",
  scopes: ["org"],
  permissions: ["report.read"],
  available: needsCommunities,
  ambientScope: "full",
  run: async (ctx) => {
    const report = await getProductionPortfolioReport({ divisionId: ctx.divisionId, communityId: ctx.communityId })
    const amount = report.variance.reduce((sum, row) => sum + row.amountCents, 0)
    const count = report.variance.reduce((sum, row) => sum + row.count, 0)

    return {
      stats: [
        { key: "amount", label: "VPO total", value: formatMoneyCents(amount), tone: amount > 0 ? "warning" : undefined },
        { key: "count", label: "VPOs", value: String(count) },
        {
          key: "share",
          label: "% of direct cost",
          value: formatPercent(report.variance.reduce((sum, row) => sum + row.percentOfDirectCost, 0)),
        },
      ],
      tables: [
        {
          key: "variance",
          columns: [
            { key: "reason", header: "Reason" },
            { key: "trade", header: "Trade" },
            { key: "count", header: "Count", type: "number" },
            { key: "amount", header: "Amount", type: "money" },
            { key: "percent", header: "% direct cost", type: "percent" },
          ],
          rows: report.variance.map((row) => ({
            key: row.key,
            cells: {
              reason: row.reason,
              trade: row.trade,
              count: row.count,
              amount: row.amountCents,
              percent: row.percentOfDirectCost,
            },
          })),
          totals: { reason: `${report.variance.length} group${report.variance.length === 1 ? "" : "s"}`, count, amount },
          emptyMessage: "No approved variance POs in this scope.",
        },
      ],
    }
  },
}

const closingBacklog: ReportDefinition = {
  slug: "closing-backlog",
  title: "Closing Backlog",
  summary: "Sold-not-closed units and value by community, with the 30-day closing horizon and what has already closed YTD.",
  group: "sales",
  scopes: ["org"],
  permissions: ["sales.read"],
  available: needsCommunities,
  ambientScope: "full",
  run: async (ctx) => {
    const rows = await getBacklogReport({ divisionId: ctx.divisionId })
    const scoped = ctx.communityId ? rows.filter((row) => row.community_id === ctx.communityId) : rows
    const sum = (key: "backlog_units" | "backlog_value_cents" | "spec_units" | "scheduled_30d_units" | "closed_units_ytd" | "closed_value_ytd_cents") =>
      scoped.reduce((total, row) => total + row[key], 0)

    return {
      stats: [
        { key: "units", label: "Backlog units", value: String(sum("backlog_units")) },
        { key: "value", label: "Backlog value", value: formatMoneyCents(sum("backlog_value_cents")) },
        { key: "spec", label: "Spec units", value: String(sum("spec_units")) },
        { key: "next30", label: "Closing next 30d", value: String(sum("scheduled_30d_units")) },
        {
          key: "ytd",
          label: "Closed YTD",
          value: String(sum("closed_units_ytd")),
          detail: formatMoneyCents(sum("closed_value_ytd_cents")),
        },
      ],
      tables: [
        {
          key: "communities",
          columns: [
            { key: "community", header: "Community" },
            { key: "community_id", header: "community_id", exportOnly: true },
            { key: "lead_units", header: "Leads", type: "number" },
            { key: "hold_units", header: "Holds", type: "number" },
            { key: "reserved_units", header: "Reserved", type: "number" },
            { key: "spec_units", header: "Spec", type: "number" },
            { key: "backlog_units", header: "Backlog", type: "number" },
            { key: "backlog_value_cents", header: "Backlog value", type: "money" },
            { key: "scheduled_30d_units", header: "Next 30d", type: "number" },
            { key: "closed_units_ytd", header: "Closed YTD", type: "number" },
            { key: "closed_value_ytd_cents", header: "Closed value YTD", type: "money" },
          ],
          rows: scoped.map((row) => ({
            key: row.community_id,
            href: `/communities/${row.community_id}`,
            cells: {
              community: row.community_name,
              community_id: row.community_id,
              lead_units: row.lead_units,
              hold_units: row.hold_units,
              reserved_units: row.reserved_units,
              spec_units: row.spec_units,
              backlog_units: row.backlog_units,
              backlog_value_cents: row.backlog_value_cents,
              scheduled_30d_units: row.scheduled_30d_units,
              closed_units_ytd: row.closed_units_ytd,
              closed_value_ytd_cents: row.closed_value_ytd_cents,
            },
          })),
          totals: {
            community: `${scoped.length} communit${scoped.length === 1 ? "y" : "ies"}`,
            spec_units: sum("spec_units"),
            backlog_units: sum("backlog_units"),
            backlog_value_cents: sum("backlog_value_cents"),
            scheduled_30d_units: sum("scheduled_30d_units"),
            closed_units_ytd: sum("closed_units_ytd"),
            closed_value_ytd_cents: sum("closed_value_ytd_cents"),
          },
          emptyMessage: "Nothing in backlog for this scope.",
        },
      ],
    }
  },
}

const salesPerformance: ReportDefinition = {
  slug: "sales-performance",
  title: "Sales Performance",
  summary: "Cancellation rate, incentive spend as a share of price, and average days from agreement to close, by community.",
  group: "sales",
  scopes: ["org"],
  permissions: ["sales.read"],
  available: needsCommunities,
  ambientScope: "full",
  run: async (ctx) => {
    const rows = await getBacklogReport({ divisionId: ctx.divisionId })
    const scoped = ctx.communityId ? rows.filter((row) => row.community_id === ctx.communityId) : rows
    const closedYtd = scoped.reduce((sum, row) => sum + row.closed_units_ytd, 0)
    const cancellations = scoped.reduce((sum, row) => sum + row.cancellation_count, 0)
    const incentive = scoped.reduce((sum, row) => sum + row.incentive_spend_cents, 0)
    const closedValue = scoped.reduce((sum, row) => sum + row.closed_value_ytd_cents, 0)
    const withDays = scoped.filter((row) => row.avg_days_agreement_to_close !== null)
    const avgDays = withDays.length
      ? Math.round(withDays.reduce((sum, row) => sum + (row.avg_days_agreement_to_close ?? 0), 0) / withDays.length)
      : null

    return {
      stats: [
        { key: "closed", label: "Closed YTD", value: String(closedYtd) },
        {
          key: "cancellations",
          label: "Cancellations",
          value: String(cancellations),
          detail: closedYtd + cancellations > 0 ? formatPercent((cancellations / (closedYtd + cancellations)) * 100) : undefined,
          tone: cancellations > 0 ? "warning" : undefined,
        },
        {
          key: "incentive",
          label: "Incentive spend",
          value: formatMoneyCents(incentive),
          detail: closedValue > 0 ? `${formatPercent((incentive / closedValue) * 100)} of closed price` : undefined,
        },
        { key: "days", label: "Agreement → close", value: avgDays === null ? "—" : `${avgDays} days` },
      ],
      tables: [
        {
          key: "communities",
          columns: [
            { key: "community", header: "Community" },
            { key: "community_id", header: "community_id", exportOnly: true },
            { key: "closed_units_ytd", header: "Closed YTD", type: "number" },
            { key: "cancellation_count", header: "Cancellations", type: "number" },
            { key: "cancellation_rate", header: "Cancel rate", type: "percent" },
            { key: "incentive_spend_cents", header: "Incentive spend", type: "money" },
            { key: "incentive_percent_of_price", header: "Incentive %", type: "percent" },
            { key: "avg_days_agreement_to_close", header: "Days to close", type: "number" },
          ],
          rows: scoped.map((row) => ({
            key: row.community_id,
            href: `/communities/${row.community_id}/offering`,
            cells: {
              community: row.community_name,
              community_id: row.community_id,
              closed_units_ytd: row.closed_units_ytd,
              cancellation_count: row.cancellation_count,
              cancellation_rate: {
                value: row.cancellation_rate,
                label: formatPercent(row.cancellation_rate),
                tone: row.cancellation_rate >= 10 ? "warning" : undefined,
              },
              incentive_spend_cents: row.incentive_spend_cents,
              incentive_percent_of_price: {
                value: row.incentive_percent_of_price,
                label: formatPercent(row.incentive_percent_of_price),
                tone: row.incentive_percent_of_price >= 5 ? "warning" : undefined,
              },
              avg_days_agreement_to_close: row.avg_days_agreement_to_close,
            },
          })),
          totals: {
            community: `${scoped.length} communit${scoped.length === 1 ? "y" : "ies"}`,
            closed_units_ytd: closedYtd,
            cancellation_count: cancellations,
            incentive_spend_cents: incentive,
          },
          emptyMessage: "No sales activity for this scope.",
        },
      ],
    }
  },
}

const cycleTime: ReportDefinition = {
  slug: "cycle-time",
  title: "Cycle Time",
  summary: "Median and 80th-percentile days from start to completion, grouped by community, plan, or superintendent.",
  group: "production",
  scopes: ["org"],
  permissions: ["report.read"],
  available: needsCommunities,
  ambientScope: "full",
  params: [
    {
      key: "groupBy",
      kind: "select",
      label: "Group by",
      options: [
        { value: "community", label: "Community" },
        { value: "plan", label: "Plan" },
        { value: "superintendent", label: "Superintendent" },
      ],
    },
    { key: "period", kind: "period", label: "Started in" },
  ],
  run: async (ctx) => {
    const groupBy = (ctx.params.groupBy ?? "community") as "community" | "plan" | "superintendent"
    const { from, to } = periodRange(ctx.params.period ?? "all")
    const rows = await getCycleTimeReport({
      groupBy,
      divisionId: ctx.divisionId,
      communityId: ctx.communityId,
      from: from ?? undefined,
      to: to ?? undefined,
    })
    const completed = rows.reduce((sum, row) => sum + row.count, 0)
    const weightedMedian = completed
      ? Math.round(rows.reduce((sum, row) => sum + row.medianDays * row.count, 0) / completed)
      : null

    return {
      subtitle: from ? `Homes started ${from} to ${to}` : "All completed homes",
      stats: [
        { key: "completed", label: "Completed homes", value: String(completed) },
        { key: "median", label: "Median cycle", value: weightedMedian === null ? "—" : `${weightedMedian} days` },
        { key: "groups", label: groupBy === "community" ? "Communities" : groupBy === "plan" ? "Plans" : "Superintendents", value: String(rows.length) },
      ],
      tables: [
        {
          key: "cycle",
          columns: [
            { key: "group", header: groupBy === "community" ? "Community" : groupBy === "plan" ? "Plan" : "Superintendent" },
            { key: "count", header: "Completed", type: "number" },
            { key: "in_progress", header: "In progress", type: "number" },
            { key: "median", header: "Median days", type: "number" },
            { key: "p80", header: "P80 days", type: "number" },
            { key: "trend", header: "Trend (days)", type: "number" },
          ],
          rows: rows.map((row) => ({
            key: row.groupKey,
            cells: {
              group: row.groupLabel,
              count: row.count,
              in_progress: row.inProgress,
              median: row.medianDays,
              p80: { value: row.p80Days, tone: weightedMedian !== null && row.p80Days > weightedMedian * 1.3 ? "warning" : undefined },
              // Negative is faster than the earlier half — that is the good direction.
              trend: { value: row.trendDelta, tone: row.trendDelta == null ? undefined : row.trendDelta > 0 ? "warning" : "positive" },
            },
          })),
          totals: { group: `${rows.length} group${rows.length === 1 ? "" : "s"}`, count: completed, in_progress: rows.reduce((sum, row) => sum + row.inProgress, 0), median: weightedMedian },
          emptyMessage: "No completed homes in this window.",
        },
      ],
    }
  },
}

const evenFlow: ReportDefinition = {
  slug: "even-flow",
  title: "Even-Flow Adherence",
  summary: "Planned versus actual starts per release week — whether the machine is running at the cadence it was set to.",
  group: "production",
  scopes: ["org"],
  permissions: ["report.read"],
  available: needsCommunities,
  ambientScope: "full",
  params: [{ key: "period", kind: "period", label: "Weeks in" }],
  run: async (ctx) => {
    const { from, to } = periodRange(ctx.params.period ?? "all")
    const today = new Date()
    const defaultFrom = new Date(today)
    defaultFrom.setMonth(defaultFrom.getMonth() - 6)
    const defaultTo = new Date(today)
    defaultTo.setMonth(defaultTo.getMonth() + 3)

    const rows = await getEvenFlowAdherence({
      divisionId: ctx.divisionId,
      communityId: ctx.communityId,
      from: from ?? defaultFrom.toISOString().slice(0, 10),
      to: to ?? defaultTo.toISOString().slice(0, 10),
    })

    const byWeek = new Map<string, { planned: number; actual: number; missed: number; plannedClosings: number; actualClosings: number }>()
    for (const row of rows) {
      const bucket = byWeek.get(row.weekStart) ?? { planned: 0, actual: 0, missed: 0, plannedClosings: 0, actualClosings: 0 }
      bucket.planned += row.plannedStarts
      bucket.actual += row.actualStarts
      bucket.missed += row.missedStarts
      bucket.plannedClosings += row.plannedClosings
      bucket.actualClosings += row.actualClosings
      byWeek.set(row.weekStart, bucket)
    }
    const weeks = Array.from(byWeek, ([weekStart, bucket]) => ({ weekStart, ...bucket })).sort((a, b) =>
      a.weekStart.localeCompare(b.weekStart),
    )
    const planned = weeks.reduce((sum, week) => sum + week.planned, 0)
    const actual = weeks.reduce((sum, week) => sum + week.actual, 0)
    const missed = weeks.reduce((sum, week) => sum + week.missed, 0)
    const plannedClosings = weeks.reduce((sum, week) => sum + week.plannedClosings, 0)
    const actualClosings = weeks.reduce((sum, week) => sum + week.actualClosings, 0)

    return {
      subtitle: `${weeks.length} release week${weeks.length === 1 ? "" : "s"} · as of ${todayIso()}`,
      stats: [
        { key: "planned", label: "Planned starts", value: String(planned) },
        { key: "actual", label: "Actual starts", value: String(actual) },
        {
          key: "adherence",
          label: "Adherence",
          value: planned > 0 ? formatPercent((actual / planned) * 100) : "—",
          tone: planned > 0 && actual / planned < 0.9 ? "warning" : "positive",
        },
        // A slot that came and went unfilled is the loss even-flow exists to
        // prevent, and it never shows up in a start count.
        { key: "missed", label: "Missed starts", value: String(missed), tone: missed > 0 ? "warning" : undefined },
        { key: "closings", label: "Closings (actual / planned)", value: `${actualClosings} / ${plannedClosings}` },
      ],
      tables: [
        {
          key: "weeks",
          columns: [
            { key: "week", header: "Week of", type: "date" },
            { key: "planned", header: "Planned", type: "number" },
            { key: "actual", header: "Actual", type: "number" },
            { key: "delta", header: "Delta", type: "number" },
            { key: "missed", header: "Missed", type: "number" },
            { key: "planned_closings", header: "Closings planned", type: "number" },
            { key: "actual_closings", header: "Closings actual", type: "number" },
          ],
          rows: weeks.map((week) => {
            const delta = week.actual - week.planned
            return {
              key: week.weekStart,
              cells: {
                week: week.weekStart,
                planned: week.planned,
                actual: week.actual,
                delta: {
                  value: delta,
                  label: delta > 0 ? `+${delta}` : String(delta),
                  tone: delta < 0 ? "warning" : delta > 0 ? "positive" : "muted",
                },
                missed: { value: week.missed, tone: week.missed > 0 ? "warning" : "muted" },
                planned_closings: week.plannedClosings,
                actual_closings: week.actualClosings,
              },
            }
          }),
          totals: { week: `${weeks.length} week${weeks.length === 1 ? "" : "s"}`, planned, actual, delta: actual - planned, missed, planned_closings: plannedClosings, actual_closings: actualClosings },
          emptyMessage: "No release slots scheduled in this window.",
        },
      ],
    }
  },
}

const varianceAnalysis: ReportDefinition = {
  slug: "variance-analysis",
  title: "Variance Analysis",
  summary: "Net cost variance sliced by reason, community, plan, vendor, or superintendent, with the rate against budget.",
  group: "production",
  scopes: ["org"],
  permissions: ["price_book.read"],
  available: needsCommunities,
  ambientScope: "division",
  params: [
    {
      key: "dimension",
      kind: "select",
      label: "Slice by",
      options: [
        { value: "reason", label: "Reason" },
        { value: "community", label: "Community" },
        { value: "plan", label: "Plan" },
        { value: "vendor", label: "Vendor" },
        { value: "superintendent", label: "Superintendent" },
        { value: "month", label: "Month" },
      ],
    },
    { key: "period", kind: "period", label: "Period" },
  ],
  run: async (ctx) => {
    const { from, to } = periodRange(ctx.params.period === "all" ? "last12" : (ctx.params.period ?? "last12"))
    const dimension = (ctx.params.dimension ?? "reason") as VarianceDimension
    const analysis = await getVarianceAnalysis({
      startDate: from ?? todayIso(),
      endDate: to ?? todayIso(),
      divisionId: ctx.divisionId,
    })
    const rows = analysis.rows.filter((row) => row.dimension === dimension)
    const net = rows.reduce((sum, row) => sum + row.net_variance_cents, 0)
    const incidence = rows.reduce((sum, row) => sum + row.incidence, 0)

    return {
      subtitle: `${from} to ${to}`,
      stats: [
        {
          key: "net",
          label: "Net variance",
          value: formatMoneyCents(net, { signed: net !== 0 }),
          tone: net > 0 ? "negative" : "positive",
        },
        { key: "incidence", label: "Occurrences", value: String(incidence) },
        { key: "groups", label: "Groups", value: String(rows.length) },
      ],
      tables: [
        {
          key: "variance",
          columns: [
            { key: "label", header: "Group" },
            { key: "incidence", header: "Occurrences", type: "number" },
            { key: "net", header: "Net variance", type: "money" },
            { key: "absolute", header: "Absolute", type: "money" },
            { key: "budget", header: "Direct cost budget", type: "money" },
            { key: "rate", header: "Variance rate", type: "percent" },
          ],
          rows: rows.map((row) => ({
            key: `${row.dimension}-${row.dimension_id}`,
            cells: {
              label: row.dimension_label,
              incidence: row.incidence,
              net: {
                value: row.net_variance_cents,
                label: formatMoneyCents(row.net_variance_cents, { signed: row.net_variance_cents !== 0 }),
                tone: row.net_variance_cents > 0 ? "negative" : "positive",
              },
              absolute: row.absolute_variance_cents,
              budget: row.direct_cost_budget_cents,
              rate: row.variance_rate,
            },
          })),
          totals: {
            label: `${rows.length} group${rows.length === 1 ? "" : "s"}`,
            incidence,
            net: { value: net, label: formatMoneyCents(net, { signed: net !== 0 }) },
            absolute: rows.reduce((sum, row) => sum + row.absolute_variance_cents, 0),
          },
          emptyMessage: "No cost variance recorded in this window.",
        },
      ],
    }
  },
}

const landSupply: ReportDefinition = {
  slug: "land-supply",
  title: "Land Supply",
  summary: "Where lot supply runs out, and how many lots each community is short by calendar year.",
  group: "production",
  scopes: ["org"],
  permissions: ["community.read"],
  available: needsCommunities,
  ambientScope: "full",
  run: async (ctx) => {
    const report = await getLandSupplyReport({ divisionId: ctx.divisionId, communityId: ctx.communityId })
    return {
      stats: [
        { key: "communities", label: "Communities", value: String(report.totals.communities) },
        { key: "sellable", label: "Sellable lots", value: String(report.totals.sellableLots) },
        { key: "scheduled", label: "Lots under contract", value: String(report.totals.scheduledLots), detail: formatMoneyCents(report.totals.scheduledCashCents) },
        { key: "dry", label: `Dry within ${report.horizonMonths}mo`, value: String(report.totals.dryWithinHorizon), tone: report.totals.dryWithinHorizon > 0 ? "warning" : undefined },
        { key: "shortfall", label: "Lots short", value: String(report.totals.shortfallLots), tone: report.totals.shortfallLots > 0 ? "negative" : undefined },
      ],
      notice: report.truncated
        ? { tone: "warning", message: "The portfolio read stopped short, so these counts are a floor, not a total." }
        : undefined,
      tables: [
        {
          key: "communities",
          columns: [
            { key: "community", header: "Community" },
            { key: "community_id", header: "community_id", exportOnly: true },
            { key: "division", header: "Division" },
            { key: "market", header: "Market" },
            { key: "sellable", header: "Sellable", type: "number" },
            { key: "months_of_supply", header: "Months of supply", type: "number" },
            { key: "dry_date", header: "Dry date", type: "date" },
            { key: "scheduled_lots", header: "Under contract", type: "number" },
            { key: "scheduled_cash_cents", header: "Takedown cash", type: "money" },
            { key: "shortfall_lots", header: "Short", type: "number" },
          ],
          rows: report.rows.map((row) => ({
            key: row.communityId,
            href: `/communities/${row.communityId}/land`,
            cells: {
              community: row.communityName,
              community_id: row.communityId,
              division: row.divisionName ?? "—",
              market: row.market ?? "—",
              sellable: row.sellableLots,
              months_of_supply: row.monthsOfSupply,
              dry_date: row.dryDate,
              scheduled_lots: row.scheduledLots,
              scheduled_cash_cents: row.scheduledCashCents,
              shortfall_lots: row.shortfallLots,
            },
          })),
          totals: {
            community: `${report.totals.communities} communit${report.totals.communities === 1 ? "y" : "ies"}`,
            sellable: report.totals.sellableLots,
            scheduled_lots: report.totals.scheduledLots,
            scheduled_cash_cents: report.totals.scheduledCashCents,
            shortfall_lots: report.totals.shortfallLots,
          },
          emptyMessage: "No communities in this scope.",
        },
      ],
    }
  },
}

export const PRODUCTION_REPORTS: ReportDefinition[] = [
  communityPnl,
  marginByDivision,
  marginByPlan,
  closingBacklog,
  salesPerformance,
  cycleTime,
  evenFlow,
  vpoLeakage,
  varianceAnalysis,
  landSupply,
]
