"use client"

import { useState } from "react"
import Link from "next/link"

import type {
  ProjectTrustCenterData,
  TrustCenterException,
  TrustCenterExceptionKind,
  TrustCenterQueueSummary,
} from "@/lib/financials/trust-center-types"
import { TRUST_CENTER_QUEUE_LABELS } from "@/lib/financials/trust-center-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  ShieldCheck,
  ShieldAlert,
  Info,
  XCircle,
  FileWarning,
  Link2Off,
  Receipt,
  Wallet,
  DollarSign,
  Ban,
  CircleDot,
} from "lucide-react"

interface TrustCenterTabProps {
  projectId: string
  data: ProjectTrustCenterData
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function severityBadge(severity: "info" | "warning" | "critical") {
  const tones = {
    critical: "border-destructive/30 bg-destructive/10 text-destructive",
    warning: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    info: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  }
  const labels = { critical: "Critical", warning: "Warning", info: "Info" }

  return (
    <Badge variant="outline" className={tones[severity]}>
      {labels[severity]}
    </Badge>
  )
}

function queueIcon(kind: TrustCenterExceptionKind) {
  const iconClass = "h-4 w-4"
  switch (kind) {
    case "invoice_total_mismatch":
      return <XCircle className={iconClass} />
    case "budget_actual_mismatch":
      return <AlertTriangle className={iconClass} />
    case "billable_no_job_cost":
      return <Link2Off className={iconClass} />
    case "incurred_billable_tieout":
      return <CircleDot className={iconClass} />
    case "approved_unbilled":
      return <Receipt className={iconClass} />
    case "billed_without_proof":
      return <FileWarning className={iconClass} />
    case "bill_no_commitment":
      return <Ban className={iconClass} />
    case "payment_unlinked":
      return <Link2Off className={iconClass} />
    case "retainage_mismatch":
      return <DollarSign className={iconClass} />
    case "qbo_sync_error":
      return <ShieldAlert className={iconClass} />
    case "job_cost_unclassified":
      return <CircleDot className={iconClass} />
    case "cash_risk_ap_before_ar":
      return <Wallet className={iconClass} />
    case "cost_paid_not_billed":
      return <DollarSign className={iconClass} />
    case "cost_billed_owner_unpaid":
      return <Receipt className={iconClass} />
    default:
      return <Info className={iconClass} />
  }
}

function queueSeverityColor(severity: "info" | "warning" | "critical") {
  switch (severity) {
    case "critical":
      return "text-destructive"
    case "warning":
      return "text-amber-600 dark:text-amber-400"
    case "info":
      return "text-sky-600 dark:text-sky-400"
  }
}

function ExceptionTable({
  exceptions,
  emptyLabel,
}: {
  exceptions: TrustCenterException[]
  emptyLabel: string
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="min-w-[200px] pl-4">Exception</TableHead>
            <TableHead className="min-w-[280px]">Description</TableHead>
            <TableHead>Severity</TableHead>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead className="w-16 pr-4 text-right">Open</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {exceptions.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                {emptyLabel}
              </TableCell>
            </TableRow>
          ) : (
            exceptions.map((ex) => (
              <TableRow key={ex.id} className="group">
                <TableCell className="pl-4">
                  <div className="font-medium">{ex.reference}</div>
                </TableCell>
                <TableCell>
                  <div className="max-w-[360px] text-sm text-muted-foreground">
                    {ex.description}
                  </div>
                </TableCell>
                <TableCell>{severityBadge(ex.severity)}</TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {ex.source_type?.replaceAll("_", " ") ?? "-"}
                  </span>
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {ex.amount_cents > 0 ? formatMoney(ex.amount_cents) : "-"}
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <Button asChild variant="ghost" size="icon" className="h-8 w-8">
                    <Link href={ex.href}>
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

export function TrustCenterTab({ projectId, data }: TrustCenterTabProps) {
  const [activeQueue, setActiveQueue] = useState<TrustCenterExceptionKind | "all">("all")

  const filteredExceptions =
    activeQueue === "all"
      ? data.exceptions
      : data.exceptions.filter((ex) => ex.kind === activeQueue)

  return (
    <div className="flex min-h-full flex-col bg-background">
      {/* ── Health Summary ──────────────────────────────────────────── */}
      <div className="grid border-b sm:grid-cols-2 lg:grid-cols-4">
        <div className="border-r border-b bg-background p-4 last:border-r-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</p>
          <div className="mt-2 flex items-center gap-2">
            {data.is_clean ? (
              <>
                <ShieldCheck className="h-6 w-6 text-emerald-600" />
                <span className="text-lg font-semibold text-emerald-700 dark:text-emerald-400">
                  All Clear
                </span>
              </>
            ) : (
              <>
                <ShieldAlert className="h-6 w-6 text-amber-600" />
                <span className="text-lg font-semibold">
                  {data.total_exception_count} Exception{data.total_exception_count !== 1 ? "s" : ""}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="border-r border-b bg-background p-4 last:border-r-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Critical</p>
          <p className={`mt-2 text-2xl font-semibold tabular-nums ${data.critical_count > 0 ? "text-destructive" : "text-foreground"}`}>
            {data.critical_count}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Requires immediate attention</p>
        </div>
        <div className="border-r border-b bg-background p-4 last:border-r-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Warnings</p>
          <p className={`mt-2 text-2xl font-semibold tabular-nums ${data.warning_count > 0 ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>
            {data.warning_count}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Review before billing or close</p>
        </div>
        <div className="border-b bg-background p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Info</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
            {data.info_count}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Informational findings</p>
        </div>
      </div>

      {/* ── Queue Selector ──────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-col border-b bg-background/95 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto">
          <button
            onClick={() => setActiveQueue("all")}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
              activeQueue === "all"
                ? "bg-foreground text-background"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
          >
            All
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {data.total_exception_count}
            </Badge>
          </button>
          {data.queues.map((queue) => (
            <button
              key={queue.kind}
              onClick={() => setActiveQueue(queue.kind)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
                activeQueue === queue.kind
                  ? "bg-foreground text-background"
                  : "bg-muted/50 text-muted-foreground hover:bg-muted"
              }`}
            >
              <span className={queueSeverityColor(queue.severity)}>
                {queueIcon(queue.kind)}
              </span>
              {queue.label}
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {queue.count}
              </Badge>
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground sm:mt-0">
          <ShieldCheck className="h-4 w-4" />
          Financial Reconciliation
        </div>
      </div>

      {/* ── Queue Detail Cards (shown when specific queue is selected) ── */}
      {activeQueue !== "all" && (
        <div className="border-b bg-muted/20 px-4 py-3">
          {data.queues
            .filter((q) => q.kind === activeQueue)
            .map((queue) => (
              <div key={queue.kind} className="flex flex-wrap items-center gap-4">
                <div className={`flex items-center gap-2 ${queueSeverityColor(queue.severity)}`}>
                  {queueIcon(queue.kind)}
                  <span className="text-sm font-semibold">{queue.label}</span>
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span>
                    <span className="font-semibold tabular-nums text-foreground">{queue.count}</span>{" "}
                    exception{queue.count !== 1 ? "s" : ""}
                  </span>
                  {queue.total_cents > 0 && (
                    <span>
                      <span className="font-semibold tabular-nums text-foreground">
                        {formatMoney(queue.total_cents)}
                      </span>{" "}
                      total exposure
                    </span>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* ── Exception Table ─────────────────────────────────────────── */}
      <ExceptionTable
        exceptions={filteredExceptions}
        emptyLabel={
          data.is_clean
            ? "No financial exceptions found. All reconciliation checks are clean."
            : activeQueue === "all"
              ? "No exceptions to display."
              : `No ${TRUST_CENTER_QUEUE_LABELS[activeQueue]} exceptions found.`
        }
      />
    </div>
  )
}
