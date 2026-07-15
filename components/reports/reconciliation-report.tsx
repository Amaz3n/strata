"use client"

import { useState } from "react"
import Link from "next/link"

import type {
  ProjectReconciliationReport,
  ReconciliationException,
  ReconciliationExceptionKind,
  ReconciliationSeverity,
} from "@/lib/services/reports/reconciliation-types"
import { RECONCILIATION_QUEUE_LABELS } from "@/lib/services/reports/reconciliation-types"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AlertTriangle, ArrowRight, ShieldCheck } from "@/components/icons"

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

const SEVERITY_TONES: Record<ReconciliationSeverity, string> = {
  critical: "border-destructive/30 bg-destructive/10 text-destructive",
  warning: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  info: "border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-400",
}

const SEVERITY_LABELS: Record<ReconciliationSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
}

function SeverityBadge({ severity }: { severity: ReconciliationSeverity }) {
  return (
    <Badge variant="outline" className={SEVERITY_TONES[severity]}>
      {SEVERITY_LABELS[severity]}
    </Badge>
  )
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: string }) {
  return (
    <div className="border-b border-r p-4 last:border-r-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("mt-2 text-2xl font-semibold tabular-nums", tone)}>{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  )
}

export function ReconciliationReportView({ report }: { report: ProjectReconciliationReport }) {
  const [activeQueue, setActiveQueue] = useState<ReconciliationExceptionKind | "all">("all")

  const filteredExceptions: ReconciliationException[] =
    activeQueue === "all" ? report.exceptions : report.exceptions.filter((ex) => ex.kind === activeQueue)

  return (
    <div className="border">
      <div className="grid border-b sm:grid-cols-2 lg:grid-cols-4">
        <div className="border-b border-r p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</p>
          <div className="mt-2 flex items-center gap-2">
            {report.is_clean ? (
              <>
                <ShieldCheck className="size-6 text-emerald-600" />
                <span className="text-lg font-semibold text-emerald-700 dark:text-emerald-400">All clear</span>
              </>
            ) : (
              <>
                <AlertTriangle className="size-6 text-amber-600" />
                <span className="text-lg font-semibold">
                  {report.total_exception_count} exception{report.total_exception_count === 1 ? "" : "s"}
                </span>
              </>
            )}
          </div>
        </div>
        <Metric
          label="Critical"
          value={String(report.critical_count)}
          detail="Requires immediate attention"
          tone={report.critical_count > 0 ? "text-destructive" : undefined}
        />
        <Metric
          label="Warnings"
          value={String(report.warning_count)}
          detail="Review before billing or close"
          tone={report.warning_count > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
        />
        <Metric label="Info" value={String(report.info_count)} detail="Informational findings" />
      </div>

      {report.failed_checks.length > 0 && (
        <div className="border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          Some checks could not run: {report.failed_checks.join(", ")}. Results below may be incomplete.
        </div>
      )}

      {report.queues.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-3">
          <button
            onClick={() => setActiveQueue("all")}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
              activeQueue === "all"
                ? "bg-foreground text-background"
                : "bg-muted/50 text-muted-foreground hover:bg-muted",
            )}
          >
            All
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              {report.total_exception_count}
            </Badge>
          </button>
          {report.queues.map((queue) => (
            <button
              key={queue.kind}
              onClick={() => setActiveQueue(queue.kind)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors",
                activeQueue === queue.kind
                  ? "bg-foreground text-background"
                  : "bg-muted/50 text-muted-foreground hover:bg-muted",
              )}
            >
              {queue.label}
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {queue.count}
              </Badge>
            </button>
          ))}
        </div>
      )}

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
          {filteredExceptions.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                {report.is_clean
                  ? "No financial exceptions found. All reconciliation checks are clean."
                  : activeQueue === "all"
                    ? "No exceptions to display."
                    : `No ${RECONCILIATION_QUEUE_LABELS[activeQueue]} exceptions found.`}
              </TableCell>
            </TableRow>
          ) : (
            filteredExceptions.map((ex) => (
              <TableRow key={ex.id}>
                <TableCell className="pl-4 font-medium">{ex.reference}</TableCell>
                <TableCell>
                  <div className="max-w-[360px] text-sm text-muted-foreground">{ex.description}</div>
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={ex.severity} />
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {ex.source_type?.replaceAll("_", " ") ?? "-"}
                  </span>
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {ex.amount_cents > 0 ? formatMoney(ex.amount_cents) : "-"}
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <Button asChild variant="ghost" size="icon" className="size-8">
                    <Link href={ex.href}>
                      <ArrowRight className="size-4" />
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
