import { formatMoneyCents, formatPercent } from "@/lib/reports/format"
import { isToggleOn, periodRange } from "@/lib/reports/params"
import type { ReportDefinition, ReportRow, ReportTable } from "@/lib/reports/types"
import { getApAgingReport } from "@/lib/services/reports/ap-aging"
import { getArAgingReport } from "@/lib/services/reports/ar-aging"
import { type AgingBucket } from "@/lib/services/reports/aging"
import { getChangeOrderLogReport } from "@/lib/services/reports/change-order-log"
import { getContingencyUsageReport } from "@/lib/services/reports/contingency-usage"
import { getDrawStatusReport } from "@/lib/services/reports/draw-status"
import { getForecastReport } from "@/lib/services/reports/forecast-ctc"
import { getPayAppRegisterReport } from "@/lib/services/reports/pay-app-register"
import { getPaymentsLedgerReport } from "@/lib/services/reports/payments-ledger"
import { getPrequalificationRegisterReport } from "@/lib/services/reports/prequalification-register"
import { getProjectProfitabilityReport, type ProfitabilitySection } from "@/lib/services/reports/project-profitability"
import { getProjectReconciliationReport } from "@/lib/services/reports/reconciliation"
import { RECONCILIATION_QUEUE_LABELS } from "@/lib/services/reports/reconciliation-types"
import { getVendor1099Report } from "@/lib/services/reports/vendor-1099"
import {
  getOrgWipOverUnderReport,
  getProjectWipOverUnderReport,
  type WipOverUnderRow,
} from "@/lib/services/reports/wip-over-under"

const BUCKET_LABELS: Record<AgingBucket, string> = {
  current: "Current",
  "1_30": "1–30",
  "31_60": "31–60",
  "61_90": "61–90",
  "90_plus": "90+",
  paid: "Paid",
  no_due_date: "No due date",
}

const BILLING_MODEL_LABELS: Record<string, string> = {
  fixed_price: "Fixed price",
  cost_plus_percent: "Cost plus %",
  cost_plus_fixed_fee: "Cost plus fee",
  cost_plus_gmp: "GMP",
  time_and_materials: "T&M",
  unknown: "Unknown",
}

function titleCase(value: string | null | undefined) {
  if (!value) return null
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase())
}

/** Project column only earns its place on an org-scoped run. */
function projectColumn(scope: string) {
  return scope === "org" ? [{ key: "project_name", header: "Project" as const }] : []
}

function projectCell(scope: string, row: { project_id: string | null; project_name: string | null }) {
  if (scope !== "org") return {}
  return {
    project_name: {
      value: row.project_name ?? "—",
      href: row.project_id ? `/projects/${row.project_id}` : undefined,
    },
  }
}

/* -------------------------------------------------------------------------- */
/* WIP / over-under                                                            */
/* -------------------------------------------------------------------------- */

function wipRow(row: WipOverUnderRow, scope: string): ReportRow {
  const overUnder = row.over_under_billing_cents
  return {
    key: row.project_id,
    href: scope === "org" ? `/projects/${row.project_id}/financials` : undefined,
    cells: {
      project_name: row.project_name,
      project_id: row.project_id,
      billing_model: { value: row.billing_model, label: BILLING_MODEL_LABELS[row.billing_model] ?? row.billing_model },
      revised_contract_cents: row.revised_contract_cents,
      actual_cost_cents: row.actual_cost_cents,
      eac_cents: row.eac_cents,
      percent_complete: row.percent_complete,
      earned_revenue_cents: row.earned_revenue_cents,
      billed_to_date_cents: row.billed_to_date_cents,
      over_under_billing_cents: {
        value: overUnder,
        label: formatMoneyCents(overUnder, { signed: overUnder !== 0 }),
        tone: overUnder > 0 ? "positive" : overUnder < 0 ? "warning" : undefined,
      },
      balance_status: {
        value: row.balance_status,
        label:
          row.balance_status === "over_billed" ? "Over" : row.balance_status === "under_billed" ? "Under" : "Even",
        tone: row.balance_status === "over_billed" ? "positive" : row.balance_status === "under_billed" ? "warning" : "muted",
      },
      forecast_gross_margin_percent: row.forecast_gross_margin_percent,
      issues: row.issues.join("; ") || null,
    },
  }
}

const wipOverUnder: ReportDefinition = {
  slug: "wip-over-under",
  title: "WIP / Over-Under Billing",
  summary: "Cost-to-cost earned revenue against billed revenue, and the over/under position that carries into the balance sheet.",
  group: "financial",
  scopes: ["org", "project"],
  permissions: ["budget.read", "invoice.read"],
  params: [
    { key: "asOf", kind: "date", label: "As of" },
    { key: "includeInactive", kind: "toggle", label: "Include inactive projects" },
  ],
  run: async (ctx) => {
    const asOf = ctx.params.asOf
    const report =
      ctx.scope === "project" && ctx.projectId
        ? await getProjectWipOverUnderReport({ projectId: ctx.projectId, asOf })
        : await getOrgWipOverUnderReport({ asOf, includeInactive: isToggleOn(ctx.params, "includeInactive") })

    const totals = report.totals
    const net = totals.net_over_under_billing_cents

    const table: ReportTable = {
      key: "projects",
      columns: [
        ...projectColumn(ctx.scope),
        { key: "project_id", header: "project_id", exportOnly: true },
        { key: "billing_model", header: "Billing model", type: "status" },
        { key: "revised_contract_cents", header: "Revised contract", type: "money" },
        { key: "actual_cost_cents", header: "Actual cost", type: "money" },
        { key: "eac_cents", header: "EAC", type: "money" },
        { key: "percent_complete", header: "% complete", type: "percent" },
        { key: "earned_revenue_cents", header: "Earned", type: "money" },
        { key: "billed_to_date_cents", header: "Billed", type: "money" },
        { key: "over_under_billing_cents", header: "Over/(under)", type: "money" },
        { key: "balance_status", header: "Position", type: "status" },
        { key: "forecast_gross_margin_percent", header: "Fcst margin", type: "percent" },
        { key: "issues", header: "issues", exportOnly: true },
      ],
      rows: report.rows.map((row) => wipRow(row, ctx.scope)),
      totals: {
        project_name: `${totals.project_count} project${totals.project_count === 1 ? "" : "s"}`,
        revised_contract_cents: totals.revised_contract_cents,
        actual_cost_cents: totals.actual_cost_cents,
        eac_cents: totals.eac_cents,
        percent_complete: totals.percent_complete,
        earned_revenue_cents: totals.earned_revenue_cents,
        billed_to_date_cents: totals.billed_to_date_cents,
        over_under_billing_cents: { value: net, label: formatMoneyCents(net, { signed: net !== 0 }) },
        forecast_gross_margin_percent: totals.forecast_gross_margin_percent,
      },
      emptyMessage: "No projects with a contract value in this scope.",
    }

    return {
      subtitle: `As of ${report.as_of}`,
      stats: [
        { key: "contract", label: "Revised contract", value: formatMoneyCents(totals.revised_contract_cents) },
        { key: "complete", label: "% complete", value: formatPercent(totals.percent_complete) },
        { key: "earned", label: "Earned revenue", value: formatMoneyCents(totals.earned_revenue_cents) },
        { key: "billed", label: "Billed to date", value: formatMoneyCents(totals.billed_to_date_cents) },
        {
          key: "net",
          label: "Net over/(under)",
          value: formatMoneyCents(net, { signed: net !== 0 }),
          detail: `${formatMoneyCents(totals.over_billed_cents)} over · ${formatMoneyCents(totals.under_billed_cents)} under`,
          tone: net > 0 ? "positive" : net < 0 ? "warning" : undefined,
        },
      ],
      tables: [table],
    }
  },
}

/* -------------------------------------------------------------------------- */
/* Aging                                                                       */
/* -------------------------------------------------------------------------- */

const arAging: ReportDefinition = {
  slug: "ar-aging",
  title: "Receivables Aging",
  summary: "Open receivables bucketed by days past due, with the overdue balance at a glance.",
  summaryByPosture: {
    residential: "Open client invoices bucketed by days past due, with the overdue balance at a glance.",
    commercial: "Open owner invoices bucketed by days past due, with the overdue balance at a glance.",
    production: "Open buyer invoices bucketed by days past due, with the overdue balance at a glance.",
  },
  group: "financial",
  scopes: ["org", "project"],
  permissions: ["report.read"],
  params: [{ key: "asOf", kind: "date", label: "As of" }],
  run: async (ctx) => {
    const report = await getArAgingReport({ projectId: ctx.projectId, asOf: ctx.params.asOf })
    const buckets: AgingBucket[] = ["current", "1_30", "31_60", "61_90", "90_plus"]

    return {
      subtitle: `As of ${report.as_of}`,
      stats: [
        { key: "open", label: "Total open", value: formatMoneyCents(report.totals.total_open_cents) },
        ...buckets.map((bucket) => ({
          key: bucket,
          label: BUCKET_LABELS[bucket],
          value: formatMoneyCents(report.totals[bucket]),
          tone: bucket === "90_plus" && report.totals[bucket] > 0 ? ("negative" as const) : undefined,
        })),
      ],
      tables: [
        {
          key: "invoices",
          columns: [
            { key: "invoice_number", header: "Invoice" },
            ...projectColumn(ctx.scope),
            { key: "customer_name", header: "Customer" },
            { key: "due_date", header: "Due", type: "date" },
            { key: "days_past_due", header: "Days late", type: "number" },
            { key: "bucket", header: "Bucket", type: "status" },
            { key: "total_cents", header: "Invoiced", type: "money" },
            { key: "open_balance_cents", header: "Open", type: "money" },
            { key: "status", header: "status", exportOnly: true },
          ],
          rows: report.rows.map((row) => ({
            key: row.invoice_id,
            href: `/invoices/${row.invoice_id}`,
            cells: {
              invoice_number: row.invoice_number ?? row.title ?? "—",
              ...projectCell(ctx.scope, row),
              customer_name: row.customer_name,
              due_date: row.due_date,
              days_past_due: row.days_past_due,
              bucket: {
                value: row.bucket,
                label: BUCKET_LABELS[row.bucket],
                tone: row.bucket === "90_plus" ? "negative" : row.days_past_due > 0 ? "warning" : "muted",
              },
              total_cents: row.total_cents,
              open_balance_cents: row.open_balance_cents,
              status: row.status,
            },
          })),
          totals: {
            invoice_number: `${report.rows.length} invoice${report.rows.length === 1 ? "" : "s"}`,
            total_cents: report.totals.total_invoiced_cents,
            open_balance_cents: report.totals.total_open_cents,
          },
          emptyMessage: "No open receivables as of this date.",
        },
      ],
    }
  },
}

const apAging: ReportDefinition = {
  slug: "ap-aging",
  title: "Payables Aging",
  summary: "Open vendor bills by age and due date, so cash outflow can be planned before it lands.",
  group: "financial",
  scopes: ["org", "project"],
  permissions: ["report.read"],
  params: [{ key: "asOf", kind: "date", label: "As of" }],
  run: async (ctx) => {
    const report = await getApAgingReport({ projectId: ctx.projectId, asOf: ctx.params.asOf })
    const buckets: AgingBucket[] = ["current", "1_30", "31_60", "61_90", "90_plus"]

    return {
      subtitle: `As of ${report.as_of}`,
      stats: [
        { key: "open", label: "Total open", value: formatMoneyCents(report.totals.total_open_cents) },
        ...buckets.map((bucket) => ({
          key: bucket,
          label: BUCKET_LABELS[bucket],
          value: formatMoneyCents(report.totals[bucket]),
          tone: bucket === "90_plus" && report.totals[bucket] > 0 ? ("negative" as const) : undefined,
        })),
      ],
      tables: [
        {
          key: "bills",
          columns: [
            { key: "bill_number", header: "Bill" },
            ...projectColumn(ctx.scope),
            { key: "commitment_title", header: "Commitment" },
            { key: "due_date", header: "Due", type: "date" },
            { key: "days_past_due", header: "Days late", type: "number" },
            { key: "bucket", header: "Bucket", type: "status" },
            { key: "total_cents", header: "Billed", type: "money" },
            { key: "open_balance_cents", header: "Open", type: "money" },
            { key: "status", header: "status", exportOnly: true },
          ],
          rows: report.rows.map((row) => ({
            key: row.bill_id,
            href: `/payables/${row.bill_id}`,
            cells: {
              bill_number: row.bill_number ?? "—",
              ...projectCell(ctx.scope, row),
              commitment_title: row.commitment_title,
              due_date: row.due_date,
              days_past_due: row.days_past_due,
              bucket: {
                value: row.bucket,
                label: BUCKET_LABELS[row.bucket],
                tone: row.bucket === "90_plus" ? "negative" : row.days_past_due > 0 ? "warning" : "muted",
              },
              total_cents: row.total_cents,
              open_balance_cents: row.open_balance_cents,
              status: row.status,
            },
          })),
          totals: {
            bill_number: `${report.rows.length} bill${report.rows.length === 1 ? "" : "s"}`,
            total_cents: report.totals.total_billed_cents,
            open_balance_cents: report.totals.total_open_cents,
          },
          emptyMessage: "No open payables as of this date.",
        },
      ],
    }
  },
}

/* -------------------------------------------------------------------------- */
/* Change orders, draws, payments                                              */
/* -------------------------------------------------------------------------- */

const changeOrderLog: ReportDefinition = {
  slug: "change-order-log",
  title: "Change Order Log",
  summary: "Every change order with status, value, and schedule impact — the register an auditor asks for.",
  summaryByPosture: {
    residential: "Every change order with status, value, and schedule impact — the register a client or lender asks for.",
    commercial: "Every change order with status, value, and schedule impact — the register an owner or auditor asks for.",
  },
  group: "financial",
  scopes: ["org", "project"],
  permissions: ["report.read"],
  params: [{ key: "asOf", kind: "date", label: "As of" }],
  run: async (ctx) => {
    const report = await getChangeOrderLogReport({ projectId: ctx.projectId, asOf: ctx.params.asOf })
    return {
      subtitle: `As of ${report.as_of}`,
      stats: [
        { key: "approved", label: "Approved", value: formatMoneyCents(report.totals.approved_total_cents) },
        { key: "pending", label: "Pending", value: formatMoneyCents(report.totals.pending_total_cents), tone: "warning" },
        { key: "count", label: "Change orders", value: String(report.rows.length) },
      ],
      tables: [
        {
          key: "change-orders",
          columns: [
            { key: "title", header: "Change order" },
            ...projectColumn(ctx.scope),
            { key: "status", header: "Status", type: "status" },
            { key: "created_at", header: "Created", type: "date" },
            { key: "approved_at", header: "Approved", type: "date" },
            { key: "days_impact", header: "Days", type: "number" },
            { key: "total_cents", header: "Value", type: "money" },
          ],
          rows: report.rows.map((row) => ({
            key: row.change_order_id,
            href: row.project_id ? `/projects/${row.project_id}/change-orders` : undefined,
            cells: {
              title: row.title ?? "Untitled",
              ...projectCell(ctx.scope, row),
              status: { value: row.status, label: titleCase(row.status) ?? "—" },
              created_at: row.created_at,
              approved_at: row.approved_at,
              days_impact: row.days_impact,
              total_cents: row.total_cents,
            },
          })),
          totals: {
            title: `${report.rows.length} change order${report.rows.length === 1 ? "" : "s"}`,
            total_cents: report.totals.approved_total_cents + report.totals.pending_total_cents,
          },
          emptyMessage: "No change orders logged in this scope.",
        },
      ],
    }
  },
}

const drawStatus: ReportDefinition = {
  slug: "draw-status",
  title: "Draw Status",
  summary: "Where every scheduled draw stands — invoiced, paid, or still waiting — with the dates behind each step.",
  group: "financial",
  scopes: ["org", "project"],
  permissions: ["report.read"],
  available: (ctx) => ctx.hasDrawSchedules,
  params: [{ key: "asOf", kind: "date", label: "As of" }],
  run: async (ctx) => {
    const report = await getDrawStatusReport({ projectId: ctx.projectId, asOf: ctx.params.asOf })
    const paid = report.rows.filter((row) => row.paid_at)
    const invoiced = report.rows.filter((row) => row.invoiced_at && !row.paid_at)
    const sum = (rows: typeof report.rows) => rows.reduce((total, row) => total + row.amount_cents, 0)

    return {
      subtitle: `As of ${report.as_of}`,
      stats: [
        { key: "scheduled", label: "Scheduled", value: formatMoneyCents(sum(report.rows)) },
        { key: "invoiced", label: "Invoiced, unpaid", value: formatMoneyCents(sum(invoiced)), tone: "warning" },
        { key: "paid", label: "Paid", value: formatMoneyCents(sum(paid)), tone: "positive" },
      ],
      tables: [
        {
          key: "draws",
          columns: [
            { key: "draw_number", header: "#", type: "number" },
            { key: "title", header: "Draw" },
            ...projectColumn(ctx.scope),
            { key: "status", header: "Status", type: "status" },
            { key: "due_date", header: "Due", type: "date" },
            { key: "invoice_number", header: "Invoice" },
            { key: "invoiced_at", header: "Invoiced", type: "date" },
            { key: "paid_at", header: "Paid", type: "date" },
            { key: "amount_cents", header: "Amount", type: "money" },
          ],
          rows: report.rows.map((row) => ({
            key: row.draw_id,
            href: row.project_id ? `/projects/${row.project_id}/financials/receivables` : undefined,
            cells: {
              draw_number: row.draw_number,
              title: row.title ?? "—",
              ...projectCell(ctx.scope, row),
              status: { value: row.status, label: titleCase(row.status) ?? "—" },
              due_date: row.due_date,
              invoice_number: row.invoice_number,
              invoiced_at: row.invoiced_at,
              paid_at: row.paid_at,
              amount_cents: row.amount_cents,
            },
          })),
          totals: {
            title: `${report.rows.length} draw${report.rows.length === 1 ? "" : "s"}`,
            amount_cents: sum(report.rows),
          },
          emptyMessage: "No draws scheduled in this scope.",
        },
      ],
    }
  },
}

const payAppRegister: ReportDefinition = {
  slug: "pay-app-register",
  title: "Pay Application Register",
  summary:
    "Every pay application with completed work, retainage held, and balance to finish — the progress-billing ledger across jobs.",
  group: "financial",
  scopes: ["org", "project"],
  permissions: ["report.read"],
  available: (ctx) => ctx.hasPayApplications,
  params: [
    {
      key: "status",
      kind: "select",
      label: "Show",
      options: [
        { value: "all", label: "All applications" },
        { value: "open", label: "Open (awaiting payment)" },
        { value: "paid", label: "Paid" },
      ],
    },
  ],
  run: async (ctx) => {
    const report = await getPayAppRegisterReport({ projectId: ctx.projectId })
    const filter = ctx.params.status ?? "all"
    const rows = report.rows.filter((row) => {
      if (filter === "open") return row.status === "submitted" || row.status === "approved" || row.status === "invoiced"
      if (filter === "paid") return row.status === "paid"
      return true
    })
    const totals = report.totals

    return {
      subtitle: `As of ${report.as_of}`,
      stats: [
        { key: "completed", label: "Completed & stored", value: formatMoneyCents(totals.completed_stored_cents) },
        {
          key: "retainage",
          label: "Retainage held",
          value: formatMoneyCents(totals.retainage_held_cents),
          tone: totals.retainage_held_cents > 0 ? "warning" : undefined,
        },
        {
          key: "due",
          label: "Open payment due",
          value: formatMoneyCents(totals.open_payment_due_cents),
          detail: "Submitted, approved, or invoiced",
        },
        { key: "balance", label: "Balance to finish", value: formatMoneyCents(totals.balance_to_finish_cents) },
      ],
      tables: [
        {
          key: "applications",
          columns: [
            { key: "application", header: "Application" },
            ...projectColumn(ctx.scope),
            { key: "period_end", header: "Period end", type: "date" },
            { key: "status", header: "Status", type: "status" },
            { key: "contract_sum_to_date_cents", header: "Contract to date", type: "money" },
            { key: "total_completed_stored_cents", header: "Completed & stored", type: "money" },
            { key: "retainage_cents", header: "Retainage", type: "money" },
            { key: "current_payment_due_cents", header: "Current due", type: "money" },
            { key: "balance_to_finish_cents", header: "Balance to finish", type: "money" },
            { key: "paid_at", header: "Paid", type: "date" },
          ],
          rows: rows.map((row) => ({
            key: row.pay_application_id,
            href: row.project_id ? `/projects/${row.project_id}/financials/receivables` : undefined,
            cells: {
              application: `App #${row.application_number}`,
              ...projectCell(ctx.scope, row),
              period_end: row.period_end,
              status: {
                value: row.status,
                label: titleCase(row.status) ?? row.status,
                tone: row.status === "paid" ? "positive" : row.status === "void" ? "muted" : undefined,
              },
              contract_sum_to_date_cents: row.contract_sum_to_date_cents,
              total_completed_stored_cents: row.total_completed_stored_cents,
              retainage_cents: row.retainage_cents,
              current_payment_due_cents: row.current_payment_due_cents,
              balance_to_finish_cents: row.balance_to_finish_cents,
              paid_at: row.paid_at,
            },
          })),
          totals: {
            application: `${rows.length} application${rows.length === 1 ? "" : "s"} · ${totals.project_count} project${totals.project_count === 1 ? "" : "s"}`,
            contract_sum_to_date_cents: totals.contract_sum_cents,
            total_completed_stored_cents: totals.completed_stored_cents,
            retainage_cents: totals.retainage_held_cents,
            balance_to_finish_cents: totals.balance_to_finish_cents,
          },
          cap:
            report.total_count > report.rows.length
              ? { shown: report.rows.length, total: report.total_count }
              : undefined,
          emptyMessage: "No pay applications in this scope.",
        },
      ],
      notice:
        rows.length > 0
          ? {
              tone: "info",
              message:
                "Money columns are cumulative to each application. Footer totals take each project's latest application, so they read as the current position, not a sum of rows.",
            }
          : undefined,
    }
  },
}

const paymentsLedger: ReportDefinition = {
  slug: "payments-ledger",
  title: "Payments Ledger",
  summary: "Every payment in or out, with method, reference, and the invoice or bill it settled.",
  group: "financial",
  scopes: ["org", "project"],
  permissions: ["report.read"],
  params: [
    {
      key: "kind",
      kind: "select",
      label: "Direction",
      options: [
        { value: "ar", label: "Received (AR)" },
        { value: "ap", label: "Paid out (AP)" },
      ],
    },
    { key: "asOf", kind: "date", label: "As of" },
  ],
  run: async (ctx) => {
    const kind = ctx.params.kind === "ap" ? "ap" : "ar"
    const report = await getPaymentsLedgerReport({ projectId: ctx.projectId, asOf: ctx.params.asOf, kind })
    const total = report.rows.reduce((sum, row) => sum + row.amount_cents, 0)

    return {
      subtitle: `${kind === "ar" ? "Payments received" : "Payments made"} as of ${report.as_of}`,
      stats: [
        { key: "total", label: kind === "ar" ? "Received" : "Paid out", value: formatMoneyCents(total) },
        { key: "count", label: "Payments", value: String(report.rows.length) },
      ],
      tables: [
        {
          key: "payments",
          columns: [
            { key: "received_at", header: "Date", type: "date" },
            ...projectColumn(ctx.scope),
            { key: "document", header: kind === "ar" ? "Invoice" : "Bill" },
            { key: "method", header: "Method" },
            { key: "reference", header: "Reference" },
            { key: "status", header: "Status", type: "status" },
            { key: "amount_cents", header: "Amount", type: "money" },
            { key: "provider", header: "provider", exportOnly: true },
          ],
          rows: report.rows.map((row) => ({
            key: row.payment_id,
            cells: {
              received_at: row.received_at,
              ...projectCell(ctx.scope, row),
              document: {
                value: row.invoice_number ?? row.bill_number ?? "—",
                href: row.invoice_id ? `/invoices/${row.invoice_id}` : row.bill_id ? `/payables/${row.bill_id}` : undefined,
              },
              method: titleCase(row.method),
              reference: row.reference,
              status: { value: row.status, label: titleCase(row.status) ?? "—" },
              amount_cents: row.amount_cents,
              provider: row.provider,
            },
          })),
          totals: {
            received_at: `${report.rows.length} payment${report.rows.length === 1 ? "" : "s"}`,
            amount_cents: total,
          },
          emptyMessage: "No payments recorded in this scope.",
        },
      ],
    }
  },
}

/* -------------------------------------------------------------------------- */
/* Project-only financial reports                                              */
/* -------------------------------------------------------------------------- */

const forecastCtc: ReportDefinition = {
  slug: "forecast-ctc",
  title: "Cost-to-Complete Forecast",
  summary: "Committed and actual cost projected to final by cost code, with the variance at completion each line carries.",
  group: "financial",
  scopes: ["project"],
  permissions: ["budget.read"],
  params: [{ key: "asOf", kind: "date", label: "As of" }],
  run: async (ctx) => {
    const report = await getForecastReport({ projectId: ctx.projectId!, asOf: ctx.params.asOf })
    const sum = (key: "adjusted_budget_cents" | "committed_cents" | "actual_cents" | "projected_final_cents" | "variance_at_completion_cents") =>
      report.rows.reduce((total, row) => total + row[key], 0)
    const variance = sum("variance_at_completion_cents")

    return {
      subtitle: report.budget_version
        ? `As of ${report.as_of} · budget v${report.budget_version}`
        : `As of ${report.as_of}`,
      notice: report.budget_id
        ? undefined
        : { tone: "warning", message: "This project has no budget, so there is nothing to forecast against." },
      stats: [
        { key: "budget", label: "Adjusted budget", value: formatMoneyCents(sum("adjusted_budget_cents")) },
        { key: "committed", label: "Committed", value: formatMoneyCents(sum("committed_cents")) },
        { key: "actual", label: "Actual", value: formatMoneyCents(sum("actual_cents")) },
        { key: "projected", label: "Projected final", value: formatMoneyCents(sum("projected_final_cents")) },
        {
          key: "variance",
          label: "Variance at completion",
          value: formatMoneyCents(variance, { signed: variance !== 0 }),
          tone: variance < 0 ? "negative" : variance > 0 ? "positive" : undefined,
        },
      ],
      tables: [
        {
          key: "cost-codes",
          columns: [
            { key: "cost_code", header: "Cost code" },
            { key: "budget_cents", header: "Budget", type: "money" },
            { key: "co_adjustment_cents", header: "CO adj.", type: "money" },
            { key: "adjusted_budget_cents", header: "Adjusted", type: "money" },
            { key: "committed_cents", header: "Committed", type: "money" },
            { key: "actual_cents", header: "Actual", type: "money" },
            { key: "estimate_remaining_cents", header: "Remaining", type: "money" },
            { key: "projected_final_cents", header: "Projected final", type: "money" },
            { key: "variance_at_completion_cents", header: "Variance", type: "money" },
          ],
          rows: report.rows.map((row, index) => {
            const rowVariance = row.variance_at_completion_cents
            return {
              key: row.cost_code_id ?? `row-${index}`,
              cells: {
                cost_code: [row.cost_code_code, row.cost_code_name].filter(Boolean).join(" · ") || "Unassigned",
                budget_cents: row.budget_cents,
                co_adjustment_cents: row.co_adjustment_cents,
                adjusted_budget_cents: row.adjusted_budget_cents,
                committed_cents: row.committed_cents,
                actual_cents: row.actual_cents,
                estimate_remaining_cents: row.estimate_remaining_cents,
                projected_final_cents: row.projected_final_cents,
                variance_at_completion_cents: {
                  value: rowVariance,
                  label: formatMoneyCents(rowVariance, { signed: rowVariance !== 0 }),
                  tone: rowVariance < 0 ? "negative" : rowVariance > 0 ? "positive" : undefined,
                },
              },
            }
          }),
          totals: {
            cost_code: `${report.rows.length} cost code${report.rows.length === 1 ? "" : "s"}`,
            adjusted_budget_cents: sum("adjusted_budget_cents"),
            committed_cents: sum("committed_cents"),
            actual_cents: sum("actual_cents"),
            projected_final_cents: sum("projected_final_cents"),
            variance_at_completion_cents: { value: variance, label: formatMoneyCents(variance, { signed: variance !== 0 }) },
          },
          emptyMessage: "No budget lines to forecast.",
        },
      ],
    }
  },
}

function profitabilitySectionRows(section: ProfitabilitySection, prefix: string): ReportRow[] {
  const rows: ReportRow[] = [
    {
      key: `${prefix}-header`,
      emphasis: "group",
      cells: { label: section.label, amount_cents: null, budget_cents: null, variance_cents: null },
    },
  ]
  for (const line of section.lines) {
    rows.push({
      key: `${prefix}-${line.key}`,
      cells: {
        label: line.label,
        amount_cents: line.amount_cents,
        budget_cents: line.budget_cents ?? null,
        variance_cents:
          typeof line.variance_cents === "number"
            ? {
                value: line.variance_cents,
                label: formatMoneyCents(line.variance_cents, { signed: true }),
                tone: line.variance_cents < 0 ? "negative" : "positive",
              }
            : null,
      },
    })
  }
  rows.push({
    key: `${prefix}-subtotal`,
    emphasis: "subtotal",
    cells: {
      label: `Total ${section.label.toLowerCase()}`,
      amount_cents: section.total_cents,
      budget_cents: section.budget_total_cents ?? null,
      variance_cents:
        typeof section.variance_total_cents === "number"
          ? { value: section.variance_total_cents, label: formatMoneyCents(section.variance_total_cents, { signed: true }) }
          : null,
    },
  })
  return rows
}

const projectProfitability: ReportDefinition = {
  slug: "profitability",
  title: "Project Profitability",
  summary: "Income, cost of work, and net profit as a P&L, with budget variance and the margin the job is actually landing.",
  group: "financial",
  scopes: ["project"],
  permissions: ["financials.margin.read"],
  params: [
    {
      key: "basis",
      kind: "select",
      label: "Basis",
      options: [
        { value: "accrual", label: "Accrual" },
        { value: "cash", label: "Cash" },
      ],
    },
    {
      key: "groupBy",
      kind: "select",
      label: "Group by",
      options: [
        { value: "category", label: "Cost category" },
        { value: "account", label: "Account" },
      ],
    },
    { key: "period", kind: "period", label: "Period" },
  ],
  run: async (ctx) => {
    const { from, to } = periodRange(ctx.params.period ?? "all")
    const report = await getProjectProfitabilityReport({
      projectId: ctx.projectId!,
      basis: ctx.params.basis === "cash" ? "cash" : "accrual",
      groupBy: ctx.params.groupBy === "account" ? "account" : "category",
      from,
      to,
    })

    return {
      subtitle: `${report.basis === "cash" ? "Cash" : "Accrual"} basis${from ? ` · ${from} to ${to}` : ""}`,
      notice:
        report.suggested_group_by !== report.group_by
          ? {
              tone: "info",
              message: `Cost-code coverage is thin here — grouping by ${report.suggested_group_by} will read more cleanly.`,
            }
          : undefined,
      stats: [
        { key: "income", label: "Income", value: formatMoneyCents(report.total_income_cents) },
        { key: "cost", label: "Cost of work", value: formatMoneyCents(report.total_cost_cents) },
        {
          key: "gross",
          label: "Gross profit",
          value: formatMoneyCents(report.gross_profit_cents),
          detail: formatPercent(report.gross_margin_percent),
          tone: report.gross_profit_cents < 0 ? "negative" : "positive",
        },
        {
          key: "net",
          label: "Net profit",
          value: formatMoneyCents(report.net_profit_cents),
          detail: formatPercent(report.net_margin_percent),
          tone: report.net_profit_cents < 0 ? "negative" : "positive",
        },
        {
          key: "budget",
          label: "Budgeted margin",
          value: report.budgeted_margin_percent === null ? "—" : formatPercent(report.budgeted_margin_percent),
          detail: report.contract_value_cents === null ? undefined : `${formatMoneyCents(report.contract_value_cents)} contract`,
        },
      ],
      tables: [
        {
          key: "pnl",
          columns: [
            { key: "label", header: "Line" },
            { key: "amount_cents", header: "Amount", type: "money" },
            { key: "budget_cents", header: "Budget", type: "money" },
            { key: "variance_cents", header: "Variance", type: "money" },
          ],
          rows: [
            ...profitabilitySectionRows(report.income, "income"),
            ...profitabilitySectionRows(report.cost_of_work, "cost"),
            {
              key: "net-profit",
              emphasis: "total",
              cells: {
                label: "Net profit",
                amount_cents: report.net_profit_cents,
                budget_cents: null,
                variance_cents: { value: null, label: formatPercent(report.net_margin_percent) },
              },
            },
          ],
          emptyMessage: "No income or cost posted to this project yet.",
        },
      ],
    }
  },
}

const reconciliation: ReportDefinition = {
  slug: "reconciliation",
  title: "Financial Reconciliation",
  summary: "Integrity checks across invoices, job costs, payments, and retainage, each linked to the record that fixes it.",
  group: "compliance",
  scopes: ["project"],
  permissions: ["report.read"],
  params: [
    {
      key: "queue",
      kind: "select",
      label: "Queue",
      options: [
        { value: "all", label: "All exceptions" },
        ...Object.entries(RECONCILIATION_QUEUE_LABELS).map(([value, label]) => ({ value, label })),
      ],
    },
  ],
  run: async (ctx) => {
    const report = await getProjectReconciliationReport(ctx.projectId!)
    const queue = ctx.params.queue ?? "all"
    const exceptions = queue === "all" ? report.exceptions : report.exceptions.filter((row) => row.kind === queue)

    return {
      subtitle: report.is_clean
        ? "All checks clean"
        : `${report.total_exception_count} exception${report.total_exception_count === 1 ? "" : "s"} found`,
      notice:
        report.failed_checks.length > 0
          ? {
              tone: "warning",
              message: `Some checks could not run (${report.failed_checks.join(", ")}). Results below may be incomplete.`,
            }
          : undefined,
      stats: [
        {
          key: "critical",
          label: "Critical",
          value: String(report.critical_count),
          detail: "Requires immediate attention",
          tone: report.critical_count > 0 ? "negative" : undefined,
        },
        {
          key: "warning",
          label: "Warnings",
          value: String(report.warning_count),
          detail: "Review before billing or close",
          tone: report.warning_count > 0 ? "warning" : undefined,
        },
        { key: "info", label: "Info", value: String(report.info_count), detail: "Informational findings" },
      ],
      tables: [
        {
          key: "exceptions",
          columns: [
            { key: "reference", header: "Exception" },
            { key: "description", header: "Description", className: "min-w-[280px]" },
            { key: "severity", header: "Severity", type: "status" },
            { key: "kind", header: "Queue" },
            { key: "source_type", header: "Source" },
            { key: "amount_cents", header: "Amount", type: "money" },
          ],
          rows: exceptions.map((row) => ({
            key: row.id,
            href: row.href,
            cells: {
              reference: row.reference,
              description: row.description,
              severity: {
                value: row.severity,
                label: titleCase(row.severity) ?? row.severity,
                tone: row.severity === "critical" ? "negative" : row.severity === "warning" ? "warning" : "muted",
              },
              kind: RECONCILIATION_QUEUE_LABELS[row.kind],
              source_type: titleCase(row.source_type),
              amount_cents: row.amount_cents > 0 ? row.amount_cents : null,
            },
          })),
          emptyMessage: report.is_clean
            ? "No financial exceptions found. All reconciliation checks are clean."
            : "No exceptions in this queue.",
        },
      ],
    }
  },
}

const contingencyUsage: ReportDefinition = {
  slug: "contingency-usage",
  title: "Contingency Usage",
  summary: "What is left in contingency, what has been drawn against it, and the transfer trail behind every movement.",
  group: "financial",
  scopes: ["project"],
  permissions: ["budget.read"],
  run: async (ctx) => {
    const report = await getContingencyUsageReport(ctx.projectId!)
    const starting = report.summaries.reduce((sum, row) => sum + row.starting_amount_cents, 0)
    const drawn = report.summaries.reduce((sum, row) => sum + row.draws_cents, 0)
    const remaining = report.summaries.reduce((sum, row) => sum + row.remaining_cents, 0)

    return {
      stats: [
        { key: "starting", label: "Starting contingency", value: formatMoneyCents(starting) },
        { key: "drawn", label: "Drawn", value: formatMoneyCents(drawn), tone: drawn > 0 ? "warning" : undefined },
        {
          key: "remaining",
          label: "Remaining",
          value: formatMoneyCents(remaining),
          tone: remaining <= 0 ? "negative" : "positive",
        },
      ],
      tables: [
        {
          key: "lines",
          title: "Contingency lines",
          columns: [
            { key: "line_name", header: "Line" },
            { key: "cost_code", header: "Cost code" },
            { key: "starting_amount_cents", header: "Starting", type: "money" },
            { key: "transfers_in_cents", header: "Transfers in", type: "money" },
            { key: "draws_cents", header: "Drawn", type: "money" },
            { key: "remaining_cents", header: "Remaining", type: "money" },
            { key: "drawn_percent", header: "% drawn", type: "percent" },
          ],
          rows: report.summaries.map((row) => ({
            key: row.budget_line_id,
            cells: {
              line_name: row.line_name,
              cost_code: row.cost_code,
              starting_amount_cents: row.starting_amount_cents,
              transfers_in_cents: row.transfers_in_cents,
              draws_cents: row.draws_cents,
              remaining_cents: {
                value: row.remaining_cents,
                tone: row.remaining_cents <= 0 ? "negative" : undefined,
              },
              drawn_percent: row.drawn_percent,
            },
          })),
          totals: {
            line_name: `${report.summaries.length} line${report.summaries.length === 1 ? "" : "s"}`,
            starting_amount_cents: starting,
            draws_cents: drawn,
            remaining_cents: remaining,
          },
          emptyMessage: "No contingency lines on this budget.",
        },
        {
          key: "entries",
          title: "Movement",
          columns: [
            { key: "transfer_number", header: "#", type: "number" },
            { key: "date", header: "Date", type: "date" },
            { key: "contingency_line", header: "Line" },
            { key: "direction", header: "Direction", type: "status" },
            { key: "reason", header: "Reason" },
            { key: "counterparty_lines", header: "Counterparty" },
            { key: "status", header: "Status", type: "status" },
            { key: "amount_cents", header: "Amount", type: "money" },
            { key: "remaining_after_cents", header: "Remaining after", type: "money" },
          ],
          rows: report.entries.map((row) => ({
            key: `${row.transfer_number}-${row.contingency_line}`,
            cells: {
              transfer_number: row.transfer_number,
              date: row.date,
              contingency_line: row.contingency_line,
              direction: {
                value: row.direction,
                label: row.direction === "draw" ? "Draw" : "Transfer in",
                tone: row.direction === "draw" ? "warning" : "positive",
              },
              reason: row.reason,
              counterparty_lines: row.counterparty_lines,
              status: { value: row.status, label: titleCase(row.status) ?? row.status },
              amount_cents: row.amount_cents,
              remaining_after_cents: row.remaining_after_cents,
            },
          })),
          emptyMessage: "No contingency movement recorded.",
        },
      ],
    }
  },
}

/* -------------------------------------------------------------------------- */
/* Compliance                                                                  */
/* -------------------------------------------------------------------------- */

const vendor1099: ReportDefinition = {
  slug: "vendor-1099",
  title: "Vendor 1099",
  summary: "Calendar-year vendor payments against the 1099 threshold, flagging who is still missing a W-9.",
  group: "compliance",
  scopes: ["org"],
  permissions: ["report.read"],
  params: [{ key: "year", kind: "select", label: "Tax year", options: taxYearOptions() }],
  run: async (ctx) => {
    const report = await getVendor1099Report({ year: Number(ctx.params.year) || undefined })
    const reportable = report.rows.filter((row) => row.meets_threshold)
    const missingW9 = reportable.filter((row) => !row.w9_on_file)

    return {
      subtitle: `Tax year ${report.tax_year} · ${formatMoneyCents(report.threshold_cents)} threshold`,
      notice:
        missingW9.length > 0
          ? {
              tone: "warning",
              message: `${missingW9.length} reportable vendor${missingW9.length === 1 ? " has" : "s have"} no W-9 on file.`,
            }
          : undefined,
      stats: [
        { key: "reportable", label: "Reportable vendors", value: String(reportable.length) },
        { key: "paid", label: "Total paid", value: formatMoneyCents(report.total_paid_cents) },
        {
          key: "missing",
          label: "Missing W-9",
          value: String(missingW9.length),
          tone: missingW9.length > 0 ? "negative" : "positive",
        },
      ],
      tables: [
        {
          key: "vendors",
          columns: [
            { key: "vendor_name", header: "Vendor" },
            { key: "tax_entity_type", header: "Entity" },
            { key: "tax_id_last4", header: "TIN last 4" },
            { key: "w9_on_file", header: "W-9", type: "status" },
            { key: "meets_threshold", header: "Reportable", type: "status" },
            { key: "total_paid_cents", header: "Paid", type: "money" },
          ],
          rows: report.rows.map((row) => ({
            key: row.company_id,
            href: `/directory/${row.company_id}`,
            cells: {
              vendor_name: row.vendor_name,
              tax_entity_type: titleCase(row.tax_entity_type),
              tax_id_last4: row.tax_id_last4 ? `••••${row.tax_id_last4}` : null,
              w9_on_file: {
                value: row.w9_on_file ? "on_file" : "missing",
                label: row.w9_on_file ? "On file" : "Missing",
                tone: row.w9_on_file ? "positive" : "negative",
              },
              meets_threshold: {
                value: row.meets_threshold ? "yes" : "no",
                label: row.meets_threshold ? "Yes" : "No",
                tone: row.meets_threshold ? undefined : "muted",
              },
              total_paid_cents: row.total_paid_cents,
            },
          })),
          totals: {
            vendor_name: `${report.rows.length} vendor${report.rows.length === 1 ? "" : "s"}`,
            total_paid_cents: report.total_paid_cents,
          },
          emptyMessage: "No vendor payments recorded for this tax year.",
        },
      ],
    }
  },
}

const prequalificationRegister: ReportDefinition = {
  slug: "prequalifications",
  title: "Prequalification Register",
  summary: "Each subcontractor's latest prequalification — limits, bonding, EMR, and who is expired or about to be.",
  group: "compliance",
  scopes: ["org"],
  permissions: ["directory.read"],
  available: (ctx) => ctx.hasPrequalifications,
  run: async () => {
    const report = await getPrequalificationRegisterReport()
    const asOf = report.as_of
    const soon = new Date(`${asOf}T00:00:00Z`)
    soon.setUTCDate(soon.getUTCDate() + 60)
    const soonIso = soon.toISOString().slice(0, 10)

    const expired = report.rows.filter((row) => row.expires_at && row.expires_at < asOf)
    const expiring = report.rows.filter((row) => row.expires_at && row.expires_at >= asOf && row.expires_at <= soonIso)
    const approved = report.rows.filter((row) => row.status === "approved")

    return {
      subtitle: `As of ${asOf}`,
      notice:
        expired.length > 0
          ? {
              tone: "warning",
              message: `${expired.length} prequalification${expired.length === 1 ? " has" : "s have"} expired. Inviting these companies to bid carries stale limits.`,
            }
          : undefined,
      stats: [
        { key: "companies", label: "Companies", value: String(report.rows.length) },
        { key: "approved", label: "Approved", value: String(approved.length) },
        {
          key: "expiring",
          label: "Expiring in 60 days",
          value: String(expiring.length),
          tone: expiring.length > 0 ? "warning" : undefined,
        },
        {
          key: "expired",
          label: "Expired",
          value: String(expired.length),
          tone: expired.length > 0 ? "negative" : "positive",
        },
      ],
      tables: [
        {
          key: "companies",
          columns: [
            { key: "company_name", header: "Company" },
            { key: "status", header: "Status", type: "status" },
            { key: "trades", header: "Trades" },
            { key: "single_project_limit_cents", header: "Single limit", type: "money" },
            { key: "aggregate_limit_cents", header: "Aggregate limit", type: "money" },
            { key: "bonding_single_cents", header: "Bonding (single)", type: "money" },
            { key: "bonding_aggregate_cents", header: "Bonding (aggregate)", type: "money" },
            { key: "emr", header: "EMR", type: "number" },
            { key: "reviewed_at", header: "Reviewed", type: "date" },
            { key: "expires_at", header: "Expires", type: "date" },
          ],
          rows: report.rows.map((row) => {
            const isExpired = Boolean(row.expires_at && row.expires_at < asOf)
            const isExpiring = Boolean(row.expires_at && row.expires_at >= asOf && row.expires_at <= soonIso)
            return {
              key: row.company_id,
              href: `/directory/${row.company_id}`,
              cells: {
                company_name: row.company_name,
                status: {
                  value: row.status,
                  label: titleCase(row.status) ?? row.status,
                  tone: row.status === "approved" ? "positive" : row.status === "rejected" ? "negative" : "muted",
                },
                trades: row.trades.join(", ") || null,
                single_project_limit_cents: row.single_project_limit_cents,
                aggregate_limit_cents: row.aggregate_limit_cents,
                bonding_single_cents: row.bonding_single_cents,
                bonding_aggregate_cents: row.bonding_aggregate_cents,
                emr: row.emr,
                reviewed_at: row.reviewed_at,
                expires_at: {
                  value: row.expires_at,
                  tone: isExpired ? "negative" : isExpiring ? "warning" : undefined,
                },
              },
            }
          }),
          emptyMessage: "No prequalifications on file.",
        },
      ],
    }
  },
}

function taxYearOptions() {
  const currentYear = new Date().getUTCFullYear()
  return [0, 1, 2, 3].map((offset) => {
    const year = currentYear - offset
    return { value: String(year), label: String(year) }
  })
}

export const FINANCIAL_REPORTS: ReportDefinition[] = [
  wipOverUnder,
  projectProfitability,
  forecastCtc,
  arAging,
  apAging,
  payAppRegister,
  paymentsLedger,
  drawStatus,
  changeOrderLog,
  contingencyUsage,
  reconciliation,
  vendor1099,
  prequalificationRegister,
]
