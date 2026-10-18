import { formatMoneyCents } from "@/lib/reports/format"
import type { ReportDefinition } from "@/lib/reports/types"
import { compareForecastSnapshotLines } from "@/lib/financials/forecasting"
import { listBudgetSnapshots } from "@/lib/services/budgets"
import { getCashFlowForecast } from "@/lib/services/reports/cash-flow-forecast"
import { getOshaLog } from "@/lib/services/reports/osha-log"
import { getTimePhasedForecast } from "@/lib/services/reports/time-phased-forecast"

const forecastTimePhased: ReportDefinition = {
  slug: "forecast-time-phased", title: "Time-Phased Forecast", group: "financial",
  summary: "Remaining cost distributed by month across the live project schedule window.", scopes: ["project"], permissions: ["report.read","budget.read"],
  params: [{ key: "curve", kind: "select", label: "Curve", options: [{ value: "linear", label: "Linear" }, { value: "front_loaded", label: "Front-loaded" }, { value: "back_loaded", label: "Back-loaded" }] }],
  run: async (ctx) => {
    if (!ctx.projectId) throw new Error("Project scope is required")
    const curve = ctx.params.curve === "front_loaded" || ctx.params.curve === "back_loaded" ? ctx.params.curve : "linear"
    const report = await getTimePhasedForecast({ projectId: ctx.projectId, curve })
    return { subtitle: `${report.start} through ${report.end}`, tables: [{ key: "forecast", columns: [{ key: "cost_code", header: "Cost code" }, { key: "name", header: "Description" }, { key: "ctc", header: "CTC", type: "money" }, ...report.months.map((month) => ({ key: month, header: month, type: "money" as const }))], rows: report.rows.map((row) => ({ key: row.key, cells: { cost_code: row.cost_code, name: row.name, ctc: row.ctc_cents, ...row.months } })), totals: { name: "Total", ctc: report.rows.reduce((sum, row) => sum + row.ctc_cents, 0), ...Object.fromEntries(report.months.map((month) => [month, report.rows.reduce((sum, row) => sum + (row.months[month] ?? 0), 0)])) }, emptyMessage: "No forecast cost remains." }] }
  },
}

const forecastHistory: ReportDefinition = {
  slug: "forecast-history", title: "Forecast History", group: "financial",
  summary: "See which cost codes moved between the two most recent forecast snapshots.", scopes: ["project"], permissions: ["report.read", "budget.read"],
  run: async (ctx) => {
    if (!ctx.projectId) throw new Error("Project scope is required")
    const snapshots = await listBudgetSnapshots(ctx.projectId)
    const [to, from] = snapshots
    if (!from || !to) {
      return { tables: [{ key: "history", columns: [{ key: "cost_code", header: "Cost code" }, { key: "from", header: "From EAC", type: "money" }, { key: "to", header: "To EAC", type: "money" }, { key: "movement", header: "Movement", type: "money" }], rows: [], emptyMessage: "Two forecast snapshots are required." }] }
    }
    const rows = compareForecastSnapshotLines(from.by_cost_code, to.by_cost_code)
      .filter((row) => row.variance_cents !== 0)
      .sort((left, right) => Math.abs(right.variance_cents) - Math.abs(left.variance_cents))
    const net = rows.reduce((sum, row) => sum + row.variance_cents, 0)
    return {
      subtitle: `${from.snapshot_date} through ${to.snapshot_date}`,
      stats: [{ key: "changed", label: "Changed cost codes", value: String(rows.length) }, { key: "net", label: "Net forecast change", value: formatMoneyCents(net), tone: net > 0 ? "negative" : net < 0 ? "positive" : "muted" }],
      tables: [{ key: "history", columns: [{ key: "cost_code", header: "Cost code" }, { key: "from", header: "From EAC", type: "money" }, { key: "to", header: "To EAC", type: "money" }, { key: "movement", header: "Movement", type: "money" }], rows: rows.map((row) => ({ key: row.key, cells: { cost_code: row.label, from: row.from_cents, to: row.to_cents, movement: { value: row.variance_cents, tone: row.variance_cents > 0 ? "negative" : "positive" } } })), emptyMessage: "No forecast movement between the latest snapshots." }],
    }
  },
}

const SHIFT_OPTIONS = [0, -4, -2, 2, 4, 8, 12].map((weeks) => ({ value: String(weeks), label: weeks === 0 ? "On schedule" : `${weeks > 0 ? "+" : "−"}${Math.abs(weeks)} week${Math.abs(weeks) === 1 ? "" : "s"}` }))
const PACE_OPTIONS = [100, 125, 75, 50, 0].map((percent) => ({ value: String(percent), label: percent === 100 ? "Starts as planned" : `Starts at ${percent}%` }))

const cashFlowForecast: ReportDefinition = {
  slug: "cash-flow-forecast", title: "Cash-Flow Forecast", group: "financial",
  summary: "Expected owner receipts and closing proceeds less approved bills, committed-but-unbilled cost, planned starts and land obligations (takedowns net of deposits, deposits, extension fees) by month.", scopes: ["org","project"], permissions: ["report.read"], ambientScope: "full",
  params: [
    { key: "closing_shift", kind: "select", label: "Closings", options: SHIFT_OPTIONS },
    { key: "start_pace", kind: "select", label: "Starts", options: PACE_OPTIONS },
  ],
  run: async (ctx) => {
    const report = await getCashFlowForecast({
      projectId: ctx.projectId, divisionId: ctx.divisionId, communityId: ctx.communityId,
      scenario: { closingShiftWeeks: Number(ctx.params.closing_shift ?? 0), startPacePercent: Number(ctx.params.start_pace ?? 100) },
    })
    const { starts, closings } = report.drivers
    const scenarioNote = report.scenario.closingShiftWeeks === 0 && report.scenario.startPacePercent === 100
      ? "Base plan."
      : `What-if: closings ${report.scenario.closingShiftWeeks >= 0 ? "+" : "−"}${Math.abs(report.scenario.closingShiftWeeks)} weeks, planned starts at ${report.scenario.startPacePercent}%.`
    const gaps = [
      starts.restricted ? "planned starts are not shown without budget and commitment access" : null,
      closings.restricted ? "closing proceeds are not shown without invoice and sales access" : null,
      starts.unbudgetedCount ? `${starts.unbudgetedCount} planned start${starts.unbudgetedCount === 1 ? " has" : "s have"} no approved budget` : null,
      starts.undatedCount ? `${starts.undatedCount} planned start${starts.undatedCount === 1 ? " has" : "s have"} no date` : null,
      closings.undatedCount ? `${closings.undatedCount} closing${closings.undatedCount === 1 ? " has" : "s have"} no date` : null,
      closings.unsignedCount ? `${closings.unsignedCount} closing${closings.unsignedCount === 1 ? " has" : "s have"} no active agreement` : null,
    ].filter((gap): gap is string => gap !== null)
    return {
      subtitle: `${scenarioNote} ${starts.count} planned start${starts.count === 1 ? "" : "s"}, ${closings.count} scheduled closing${closings.count === 1 ? "" : "s"}.`,
      notice: { tone: "info", message: `Construction financing (loan draws, interest and payoffs) is not included.${gaps.length ? ` Left out for lack of data: ${gaps.join("; ")}.` : ""}` },
      stats: [{ key: "net", label: "Forecast net", value: formatMoneyCents(report.totals.net_cents), tone: report.totals.net_cents < 0 ? "warning" : "positive" }],
      tables: [{ key: "cash_flow", columns: [{ key: "month", header: "Month" }, { key: "inflow", header: "Receivables", type: "money" }, { key: "closings", header: "Closing proceeds", type: "money" }, { key: "outflow", header: "Approved bills", type: "money" }, { key: "unbilled", header: "Committed unbilled", type: "money" }, { key: "starts", header: "Planned starts", type: "money" }, { key: "land", header: "Land obligations", type: "money" }, { key: "net", header: "Net", type: "money" }], rows: report.rows.map((row) => ({ key: row.month, cells: { month: row.month, inflow: row.inflow_cents, closings: row.closing_proceeds_cents, outflow: row.outflow_cents, unbilled: row.committed_unbilled_cents, starts: row.starts_cost_cents, land: row.land_obligations_cents, net: { value: row.net_cents, tone: row.net_cents < 0 ? "warning" : "positive" } } })), totals: { month: "Total", inflow: report.totals.inflow_cents, closings: report.totals.closing_proceeds_cents, outflow: report.totals.outflow_cents, unbilled: report.totals.committed_unbilled_cents, starts: report.totals.starts_cost_cents, land: report.totals.land_obligations_cents, net: report.totals.net_cents }, emptyMessage: "No forecast cash movements in this scope." }] }
  },
}

const oshaLog: ReportDefinition = {
  slug: "osha-300-log", title: "OSHA 300 / 300A / 301", group: "compliance",
  summary: "Recordable incidents and annual totals for OSHA 300-series filing.", scopes: ["org","project"], permissions: ["report.read","safety.read"],
  params: [{ key: "year", kind: "select", label: "Year", options: Array.from({ length: 6 }, (_, index) => { const year = new Date().getUTCFullYear() - index; return { value: String(year), label: String(year) } }) }],
  run: async (ctx) => {
    const year = Number(ctx.params.year) || new Date().getUTCFullYear()
    const report = await getOshaLog({ year, projectId: ctx.projectId })
    return { subtitle: `Calendar year ${year}`, stats: [{ key: "cases", label: "Recordable cases", value: String(report.summary.total_cases) }, { key: "away", label: "Days away", value: String(report.summary.total_days_away) }, { key: "restricted", label: "Restricted days", value: String(report.summary.total_restricted_days) }], tables: [{ key: "osha_300", columns: [{ key: "case", header: "Case" }, { key: "date", header: "Date", type: "date" }, { key: "employee", header: "Employee" }, { key: "job", header: "Job title" }, { key: "description", header: "Injury / illness" }, { key: "case_type", header: "Case type", type: "status" }, { key: "injury_type", header: "Classification", type: "status" }, { key: "days_away", header: "Days away", type: "number" }, { key: "restricted", header: "Restricted", type: "number" }], rows: report.rows.map((row) => ({ key: row.id, cells: { case: row.incident_number, date: row.occurred_at.slice(0, 10), employee: row.employee_name, job: row.employee_job_title, description: row.description, case_type: row.osha_case_type, injury_type: row.injury_illness_type, days_away: row.days_away_from_work, restricted: row.days_job_transfer_restriction } })), emptyMessage: "No recordable cases for this year." }] }
  },
}

export const PARITY_REPORTS: ReportDefinition[] = [forecastTimePhased, forecastHistory, cashFlowForecast, oshaLog]
