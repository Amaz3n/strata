"use client"

import Link from "next/link"
import { format } from "date-fns"

import type { PortfolioFinancialControlData, PortfolioFinancialRow } from "@/lib/financials/portfolio-control"
import { agingBuckets } from "@/lib/financials/portfolio-control"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ArrowRight, AlertTriangle, CheckCircle2, Clock, Wallet } from "@/components/icons"

interface FinancialControlClientProps {
  data: PortfolioFinancialControlData
}

const agingLabels: Record<(typeof agingBuckets)[number], string> = {
  current: "Current",
  "1_30": "1-30",
  "31_60": "31-60",
  "61_90": "61-90",
  "90_plus": "90+",
}

function formatMoney(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function formatDate(value?: string | null) {
  if (!value) return "-"
  return format(new Date(value), "MMM d, yyyy")
}

function statusBadge(status: string) {
  const normalized = status.toLowerCase()
  const tone =
    normalized.includes("error") || normalized.includes("failed") || normalized.includes("blocked")
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : normalized.includes("paid") || normalized.includes("clear") || normalized.includes("ready")
        ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400"

  return (
    <Badge variant="outline" className={tone}>
      {status.replaceAll("_", " ")}
    </Badge>
  )
}

function SummaryCard({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string
  value: string
  detail: string
  tone?: "default" | "danger" | "success"
}) {
  const toneClass =
    tone === "danger"
      ? "text-destructive"
      : tone === "success"
        ? "text-emerald-700 dark:text-emerald-400"
        : "text-foreground"

  return (
    <div className="border-r border-b bg-background p-4 last:border-r-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

function AgingStrip({
  title,
  values,
}: {
  title: string
  values: PortfolioFinancialControlData["aging"]["ar"]
}) {
  return (
    <div className="border-b px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
        {agingBuckets.map((bucket) => (
          <div key={bucket} className="rounded-md border bg-muted/20 px-3 py-1.5">
            <span className="mr-2 text-[11px] text-muted-foreground">{agingLabels[bucket]}</span>
            <span className="text-xs font-semibold tabular-nums">{formatMoney(values[bucket])}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function RowTable({ rows, emptyLabel }: { rows: PortfolioFinancialRow[]; emptyLabel: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="min-w-[220px] pl-4">Reference</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Counterparty</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="w-20 text-right pr-4">Open</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="h-48 text-center text-muted-foreground">
                {emptyLabel}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={`${row.kind}-${row.id}`} className="group">
                <TableCell className="pl-4">
                  <div className="font-medium">{row.reference}</div>
                  {row.age_days != null && row.age_days > 0 && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {row.age_days} days aged
                    </div>
                  )}
                </TableCell>
                <TableCell>{row.project_name ?? "-"}</TableCell>
                <TableCell>{row.counterparty ?? "-"}</TableCell>
                <TableCell>{statusBadge(row.status)}</TableCell>
                <TableCell>{formatDate(row.due_date)}</TableCell>
                <TableCell className="max-w-[240px] truncate text-muted-foreground">{row.reason ?? "-"}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{formatMoney(row.amount_cents)}</TableCell>
                <TableCell className="pr-4 text-right">
                  <Button asChild variant="ghost" size="icon" className="h-8 w-8">
                    <Link href={row.href}>
                      <ArrowRight className="h-4 w-4" />
                      <span className="sr-only">Open source</span>
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export function FinancialControlClient({ data }: FinancialControlClientProps) {
  const { summary } = data
  const cashFlowTone = summary.cash_flow_30_day_cents < 0 ? "danger" : "success"

  return (
    <div className="flex min-h-full flex-col bg-background">
      <div className="grid border-t sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <SummaryCard label="Open AR" value={formatMoney(summary.ar_open_cents)} detail={`${formatMoney(summary.ar_overdue_cents)} overdue`} />
        <SummaryCard label="Open AP" value={formatMoney(summary.ap_open_cents)} detail={`${formatMoney(summary.ap_due_soon_cents)} due in 30 days`} />
        <SummaryCard label="Ready to Invoice" value={formatMoney(summary.ready_to_invoice_cents)} detail="Approved costs across jobs" tone="success" />
        <SummaryCard label="Blocked" value={formatMoney(summary.blocked_payment_cents)} detail="Compliance, waivers, or coding" tone={summary.blocked_payment_cents > 0 ? "danger" : "success"} />
        <SummaryCard label="QBO Exceptions" value={String(summary.qbo_exception_count)} detail="Pending or failed syncs" tone={summary.qbo_exception_count > 0 ? "danger" : "success"} />
        <SummaryCard label="30-Day Net" value={formatMoney(summary.cash_flow_30_day_cents)} detail="AR due minus AP due" tone={cashFlowTone} />
        <div className="border-b bg-muted/20 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Controller Focus</p>
          <div className="mt-3 flex items-center gap-2 text-sm font-medium">
            {summary.blocked_payment_cents > 0 || summary.qbo_exception_count > 0 ? (
              <AlertTriangle className="h-4 w-4 text-destructive" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            )}
            Clear risk queue
          </div>
        </div>
      </div>

      <Tabs defaultValue="blocked" className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-col border-b bg-background/95 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
            <TabsTrigger value="blocked">Blocked</TabsTrigger>
            <TabsTrigger value="ready">Ready to Invoice</TabsTrigger>
            <TabsTrigger value="ar">AR Aging</TabsTrigger>
            <TabsTrigger value="ap">AP Aging</TabsTrigger>
            <TabsTrigger value="qbo">QBO Sync</TabsTrigger>
          </TabsList>
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground sm:mt-0">
            <Wallet className="h-4 w-4" />
            Company-wide financial control
          </div>
        </div>

        <TabsContent value="blocked" className="m-0 flex min-h-0 flex-1 flex-col">
          <RowTable rows={data.blockedRows} emptyLabel="No blocked financial items." />
        </TabsContent>
        <TabsContent value="ready" className="m-0 flex min-h-0 flex-1 flex-col">
          <RowTable rows={data.readyToInvoiceRows} emptyLabel="No approved costs are ready to invoice." />
        </TabsContent>
        <TabsContent value="ar" className="m-0 flex min-h-0 flex-1 flex-col">
          <AgingStrip title="AR Aging" values={data.aging.ar} />
          <RowTable rows={data.arRows} emptyLabel="No open receivables." />
        </TabsContent>
        <TabsContent value="ap" className="m-0 flex min-h-0 flex-1 flex-col">
          <AgingStrip title="AP Aging" values={data.aging.ap} />
          <RowTable rows={data.apRows} emptyLabel="No open payables." />
        </TabsContent>
        <TabsContent value="qbo" className="m-0 flex min-h-0 flex-1 flex-col">
          <RowTable rows={data.qboRows} emptyLabel="No QBO sync exceptions." />
        </TabsContent>
      </Tabs>
    </div>
  )
}
