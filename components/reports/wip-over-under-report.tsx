import Link from "next/link"

import type { WipOverUnderReport, WipOverUnderRow } from "@/lib/services/reports/wip-over-under"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Download } from "@/components/icons"

const MODEL_LABELS: Record<string, string> = {
  fixed_price: "Fixed price",
  cost_plus_percent: "Cost plus %",
  cost_plus_fixed_fee: "Cost plus fee",
  cost_plus_gmp: "GMP",
  time_and_materials: "T&M",
  unknown: "Unknown",
}

function formatCurrency(cents?: number | null, opts?: { signed?: boolean }) {
  if (typeof cents !== "number") return "—"
  const dollars = cents / 100
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    signDisplay: opts?.signed ? "always" : "auto",
  })
}

function formatPercent(value?: number | null) {
  if (typeof value !== "number") return "—"
  return `${value.toFixed(1)}%`
}

function statusLabel(row: WipOverUnderRow) {
  if (row.balance_status === "over_billed") return "Over"
  if (row.balance_status === "under_billed") return "Under"
  return "Even"
}

function statusClass(row: WipOverUnderRow) {
  if (row.balance_status === "over_billed") return "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
  if (row.balance_status === "under_billed") return "border-amber-500/40 text-amber-700 dark:text-amber-300"
  return "text-muted-foreground"
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "positive" | "warning"
}) {
  return (
    <div className="border-b border-r px-4 py-3 last:border-r-0 sm:px-5">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 text-xl font-semibold tabular-nums",
          tone === "positive" && "text-emerald-600 dark:text-emerald-400",
          tone === "warning" && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
      </div>
    </div>
  )
}

export function WipOverUnderReportView({
  report,
  csvHref,
}: {
  report: WipOverUnderReport
  csvHref: string
}) {
  const rows = report.rows
  const hasProjectLinks = report.scope === "org"

  return (
    <div className="space-y-4">
      <div className="grid overflow-hidden border sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="Revised contract" value={formatCurrency(report.totals.revised_contract_cents)} />
        <Metric label="% complete" value={formatPercent(report.totals.percent_complete)} />
        <Metric label="Earned revenue" value={formatCurrency(report.totals.earned_revenue_cents)} />
        <Metric label="Billed to date" value={formatCurrency(report.totals.billed_to_date_cents)} />
        <Metric
          label="Net over/(under)"
          value={formatCurrency(report.totals.net_over_under_billing_cents, { signed: true })}
          tone={report.totals.net_over_under_billing_cents >= 0 ? "positive" : "warning"}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {report.totals.project_count} project{report.totals.project_count === 1 ? "" : "s"} as of {report.as_of}
        </div>
        <Button asChild variant="secondary" size="sm">
          <a href={csvHref}>
            <Download className="mr-2 h-4 w-4" />
            CSV
          </a>
        </Button>
      </div>

      <div className="overflow-x-auto border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead className="text-right">Revised</TableHead>
              <TableHead className="text-right">% complete</TableHead>
              <TableHead className="text-right">Earned</TableHead>
              <TableHead className="text-right">Billed</TableHead>
              <TableHead className="text-right">Over/(under)</TableHead>
              <TableHead className="text-right">EAC</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-sm text-muted-foreground">
                  No WIP rows.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.project_id}>
                  <TableCell className="min-w-52 font-medium">
                    {hasProjectLinks ? (
                      <Link className="underline-offset-4 hover:underline" href={`/projects/${row.project_id}/reports/wip`}>
                        {row.project_name}
                      </Link>
                    ) : (
                      row.project_name
                    )}
                    {row.issues.length > 0 ? (
                      <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">{row.issues.join(", ")}</div>
                    ) : null}
                  </TableCell>
                  <TableCell>{MODEL_LABELS[row.billing_model] ?? row.billing_model}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(row.revised_contract_cents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(row.percent_complete)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(row.earned_revenue_cents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(row.billed_to_date_cents)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatCurrency(row.over_under_billing_cents, { signed: true })}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(row.eac_cents)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={statusClass(row)}>
                      {statusLabel(row)}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
