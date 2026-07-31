import { formatMoneyCents } from "@/lib/reports/format"
import type { ReportDefinition } from "@/lib/reports/types"
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

const cashFlowForecast: ReportDefinition = {
  slug: "cash-flow-forecast", title: "Cash-Flow Forecast", group: "financial",
  summary: "Expected owner receipts less approved bills and committed-but-unbilled cost by month.", scopes: ["org","project"], permissions: ["report.read"], ambientScope: "full",
  run: async (ctx) => {
    const report = await getCashFlowForecast({ projectId: ctx.projectId, divisionId: ctx.divisionId, communityId: ctx.communityId })
    const net = report.rows.reduce((sum, row) => sum + row.net_cents, 0)
    return { stats: [{ key: "net", label: "Forecast net", value: formatMoneyCents(net), tone: net < 0 ? "warning" : "positive" }], tables: [{ key: "cash_flow", columns: [{ key: "month", header: "Month" }, { key: "inflow", header: "Inflows", type: "money" }, { key: "outflow", header: "Approved bills", type: "money" }, { key: "unbilled", header: "Committed unbilled", type: "money" }, { key: "net", header: "Net", type: "money" }], rows: report.rows.map((row) => ({ key: row.month, cells: { month: row.month, inflow: row.inflow_cents, outflow: row.outflow_cents, unbilled: row.committed_unbilled_cents, net: { value: row.net_cents, tone: row.net_cents < 0 ? "warning" : "positive" } } })), emptyMessage: "No forecast cash movements in this scope." }] }
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

export const PARITY_REPORTS: ReportDefinition[] = [forecastTimePhased, cashFlowForecast, oshaLog]
