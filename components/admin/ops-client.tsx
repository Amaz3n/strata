"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { RotateCw } from "@/components/icons"
import { cn } from "@/lib/utils"
import {
  reconcilePaymentsNowAction,
  resolveReconciliationExceptionAction,
  retryAllFailedOutboxAction,
  retryOutboxItemAction,
} from "@/app/(app)/admin/ops/actions"
import type {
  PaymentReconciliationException,
  PaymentReconciliationSummary,
} from "@/lib/services/payment-reconciliation"
import type {
  CronJobHealth,
  OutboxHealth,
  PaymentOperationsAlert,
  QboConnectionHealth,
  StuckOutboxHealth,
} from "@/lib/services/ops"

interface OpsClientProps {
  cronHealth: CronJobHealth[]
  outboxHealth: OutboxHealth
  stuckHealth: StuckOutboxHealth
  qboHealth: QboConnectionHealth[]
  reconciliations: PaymentReconciliationSummary[]
  reconciliationExceptions: PaymentReconciliationException[]
  paymentAlerts: PaymentOperationsAlert[]
}

const PAYMENT_ALERT_LABELS: Record<string, string> = {
  payment_submission_needs_recovery: "Submission needs recovery",
  vendor_transfer_needs_attention: "Vendor transfer stuck",
  payment_operations_alert: "Operations alert",
  vendor_payout_destination_changed: "Payout bank changed",
}

const CRON_STATE_LABEL: Record<CronJobHealth["state"], string> = {
  healthy: "Healthy",
  failing: "Failing",
  overdue: "Overdue",
  "no-data": "No runs yet",
}

function relative(value: string | null) {
  return value ? formatDistanceToNow(new Date(value), { addSuffix: true }) : "—"
}

function exact(value: string | null) {
  return value ? format(new Date(value), "MMM d, HH:mm:ss") : undefined
}

export function OpsClient({
  cronHealth,
  outboxHealth,
  stuckHealth,
  qboHealth,
  reconciliations,
  reconciliationExceptions,
  paymentAlerts,
}: OpsClientProps) {
  const router = useRouter()
  const [refreshing, startRefreshing] = useTransition()
  const [retryingId, setRetryingId] = useState<number | null>(null)
  const [retryingAll, startRetryingAll] = useTransition()

  const overdueCount = cronHealth.filter((job) => job.state === "overdue").length
  const failingCount = cronHealth.filter((job) => job.state === "failing").length
  const qboErrorCount = qboHealth.filter(
    (conn) => conn.lastError || conn.status !== "connected" || conn.refreshFailureCount > 0,
  ).length

  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [resolveNote, setResolveNote] = useState("")

  const money = (cents: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)

  const reconcileNow = () => {
    startRefreshing(async () => {
      const result = await reconcilePaymentsNowAction()
      if (result.success) {
        toast.success(
          result.data.exceptionCount > 0
            ? `Reconciled with ${result.data.exceptionCount} exception${result.data.exceptionCount === 1 ? "" : "s"}`
            : "Reconciled — everything balanced",
        )
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const resolveException = (itemId: string) => {
    if (resolveNote.trim().length < 8) {
      toast.error("Say what you found in at least a few words")
      return
    }
    startRefreshing(async () => {
      const result = await resolveReconciliationExceptionAction({ itemId, note: resolveNote.trim() })
      if (result.success) {
        setResolvingId(null)
        setResolveNote("")
        toast.success("Exception resolved")
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const handleRetry = (id: number) => {
    setRetryingId(id)
    startRefreshing(async () => {
      const result = await retryOutboxItemAction({ id })
      if (result.success) {
        toast.success(`Outbox job #${id} queued for retry`)
        router.refresh()
      } else {
        toast.error("Retry failed", { description: result.error })
      }
      setRetryingId(null)
    })
  }

  const handleRetryAll = () => {
    startRetryingAll(async () => {
      const result = await retryAllFailedOutboxAction()
      if (result.success) {
        toast.success(`${result.data.retried} failed jobs queued for retry`)
        router.refresh()
      } else {
        toast.error("Retry failed", { description: result.error })
      }
    })
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      <div className="relative z-20 shrink-0 border-b bg-background/95 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold">Ops</span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={refreshing}
              onClick={() => startRefreshing(() => router.refresh())}
            >
              <RotateCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="relative z-10 min-h-0 flex-1 overflow-auto">
        {/* Stat strip */}
        <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Overdue crons" value={overdueCount} alarm={overdueCount > 0} hint="past 2× cadence" />
          <Stat label="Failing crons" value={failingCount} alarm={failingCount > 0} hint="last run errored" />
          <Stat label="Outbox failed" value={outboxHealth.failedCount} alarm={outboxHealth.failedCount > 0} hint="need attention" />
          <Stat
            label="Outbox stuck"
            value={stuckHealth.totalStuck}
            alarm={stuckHealth.totalStuck > 0}
            hint={`no progress in ${stuckHealth.thresholdMinutes}m`}
          />
          <Stat label="Outbox pending" value={outboxHealth.pendingCount} hint="waiting to run" />
          <Stat label="QBO alerts" value={qboErrorCount} alarm={qboErrorCount > 0} hint="connections w/ issues" />
        </div>

        {/* Scheduled jobs */}
        <SectionHeading>Scheduled jobs</SectionHeading>
        <div className="border-y">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow>
                <TableHead className="pl-4">Job</TableHead>
                <TableHead>Cadence</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Last success</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">Failures 24h</TableHead>
                <TableHead className="pr-4">State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cronHealth.map((job) => (
                <TableRow key={job.name}>
                  <TableCell className="pl-4 py-2.5">
                    <div className="text-sm font-medium">{job.name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{job.path}</div>
                    {job.lastError ? (
                      <div className="mt-1 max-w-md truncate font-mono text-[11px] text-destructive" title={job.lastError}>
                        {job.lastError}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="py-2.5 text-xs text-muted-foreground">{job.scheduleLabel}</TableCell>
                  <TableCell className="py-2.5 text-xs" title={exact(job.lastRunAt)}>
                    {relative(job.lastRunAt)}
                  </TableCell>
                  <TableCell className="py-2.5 text-xs" title={exact(job.lastSuccessAt)}>
                    {relative(job.lastSuccessAt)}
                  </TableCell>
                  <TableCell className="py-2.5 text-right text-xs tabular-nums text-muted-foreground">
                    {job.lastRunDurationMs !== null ? `${(job.lastRunDurationMs / 1000).toFixed(1)}s` : "—"}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "py-2.5 text-right text-xs tabular-nums",
                      job.failuresLast24h > 0 ? "font-medium text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {job.failuresLast24h}
                  </TableCell>
                  <TableCell className="py-2.5 pr-4">
                    <StateBadge state={job.state} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {cronHealth.every((job) => job.state === "no-data") ? (
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              No runs recorded yet — heartbeats start appearing after the next scheduled run of each job.
            </p>
          ) : null}
        </div>

        {/* Outbox */}
        <div className="flex items-center justify-between px-4 pb-2 pt-5">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Outbox queue
            <span className="ml-2 normal-case tracking-normal">
              {outboxHealth.pendingCount} pending · {outboxHealth.processingCount} processing ·{" "}
              {outboxHealth.completedLast24h} completed in 24h
              {outboxHealth.oldestPendingAt ? ` · oldest pending ${relative(outboxHealth.oldestPendingAt)}` : ""}
            </span>
          </h2>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
              <Link href="/admin/ops/drawings">Drawings dead letters</Link>
            </Button>
            {outboxHealth.failedCount > 0 ? (
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={retryingAll} onClick={handleRetryAll}>
                {retryingAll ? "Retrying…" : `Retry all failed (${outboxHealth.failedCount})`}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="border-y">
          {outboxHealth.failedItems.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">No failed outbox jobs. Queue is healthy.</p>
          ) : (
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="pl-4">ID</TableHead>
                  <TableHead>Job type</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead className="text-right">Retries</TableHead>
                  <TableHead>Last error</TableHead>
                  <TableHead>Failed</TableHead>
                  <TableHead className="pr-4 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outboxHealth.failedItems.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="pl-4 py-2.5 font-mono text-xs">{item.id}</TableCell>
                    <TableCell className="py-2.5 font-mono text-xs">{item.jobType}</TableCell>
                    <TableCell className="py-2.5 text-xs">{item.orgName ?? "—"}</TableCell>
                    <TableCell className="py-2.5 text-right text-xs tabular-nums">{item.retryCount}</TableCell>
                    <TableCell className="py-2.5">
                      <div className="max-w-sm truncate font-mono text-[11px] text-destructive" title={item.lastError ?? undefined}>
                        {item.lastError ?? "—"}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 text-xs" title={exact(item.updatedAt)}>
                      {relative(item.updatedAt)}
                    </TableCell>
                    <TableCell className="py-2.5 pr-4 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={retryingId === item.id}
                        onClick={() => handleRetry(item.id)}
                      >
                        {retryingId === item.id ? "Retrying…" : "Retry"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {outboxHealth.failedCount > outboxHealth.failedItems.length ? (
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              Showing the {outboxHealth.failedItems.length} most recent of {outboxHealth.failedCount} failed jobs.
            </p>
          ) : null}
        </div>

        {/* Stuck jobs */}
        <div className="px-4 pb-2 pt-5">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Stuck jobs
            <span className="ml-2 normal-case tracking-normal">
              {stuckHealth.pendingStuck} pending past due · {stuckHealth.processingStuck} processing without
              progress · idle over {stuckHealth.thresholdMinutes}m
            </span>
          </h2>
        </div>
        <div className="border-y">
          {stuckHealth.groups.length === 0 ? (
            <p className="flex items-center justify-center gap-2 px-4 py-6 text-center text-sm text-muted-foreground">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
              No stuck jobs. Every queued job has moved in the last {stuckHealth.thresholdMinutes} minutes.
            </p>
          ) : (
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="pl-4">Job type</TableHead>
                  <TableHead className="text-right">Pending</TableHead>
                  <TableHead className="text-right">Processing</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Oldest</TableHead>
                  <TableHead>Affected orgs</TableHead>
                  <TableHead className="pr-4">Last error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stuckHealth.groups.map((group) => (
                  <TableRow key={group.jobType}>
                    <TableCell className="pl-4 py-2.5 font-mono text-xs">{group.jobType}</TableCell>
                    <TableCell
                      className={cn(
                        "py-2.5 text-right text-xs tabular-nums",
                        group.pendingCount > 0 ? "font-medium text-warning" : "text-muted-foreground",
                      )}
                    >
                      {group.pendingCount}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "py-2.5 text-right text-xs tabular-nums",
                        group.processingCount > 0 ? "font-medium text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {group.processingCount}
                    </TableCell>
                    <TableCell className="py-2.5 text-right text-xs font-medium tabular-nums">
                      {group.totalCount}
                    </TableCell>
                    <TableCell className="py-2.5 text-xs" title={exact(group.oldestStuckSince)}>
                      {relative(group.oldestStuckSince)}
                    </TableCell>
                    <TableCell className="py-2.5 text-xs">
                      <div className="max-w-xs truncate" title={orgsLabel(group)}>
                        {orgsLabel(group)}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 pr-4">
                      <div
                        className="max-w-sm truncate font-mono text-[11px] text-destructive"
                        title={group.sampleLastError ?? undefined}
                      >
                        {group.sampleLastError ?? "—"}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {stuckHealth.truncated ? (
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              Grouped from the {stuckHealth.scannedCount} oldest of {stuckHealth.totalStuck} stuck jobs — per-type
              counts are a floor, not the total.
            </p>
          ) : null}
        </div>

        {/*
          Payment operations. These events were emitted for a human — a
          submission that needs recovery, a vendor transfer stuck at the
          provider, a tripped loss ceiling — and had no surface reading them.
          Read-only: each row deep-links to the payable it concerns where it can.
        */}
        <SectionHeading>Payment operations</SectionHeading>
        <div className="border-y">
          {paymentAlerts.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No payment alerts in the last two weeks.
            </p>
          ) : (
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="pl-4">Alert</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead className="pr-4">Age</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paymentAlerts.map((alert) => (
                  <TableRow key={alert.id}>
                    <TableCell className="pl-4 py-2.5 text-xs font-medium">
                      {PAYMENT_ALERT_LABELS[alert.eventType] ?? alert.eventType}
                    </TableCell>
                    <TableCell className="py-2.5 text-xs">{alert.orgName ?? "—"}</TableCell>
                    <TableCell className="py-2.5 font-mono text-[11px] text-muted-foreground">
                      {alert.billId ? (
                        <Link href={`/payables?bill=${alert.billId}`} className="underline underline-offset-2 hover:text-foreground">
                          bill {alert.billId.slice(0, 8)}
                        </Link>
                      ) : alert.runId ? (
                        <Link href={`/payables?run=${alert.runId}`} className="underline underline-offset-2 hover:text-foreground">
                          run {alert.runId.slice(0, 8)}
                        </Link>
                      ) : alert.disbursementId ? (
                        <span>disb {alert.disbursementId.slice(0, 8)}</span>
                      ) : (
                        "—"
                      )}
                      {alert.disbursementId && (alert.billId || alert.runId) ? (
                        <span className="ml-2">disb {alert.disbursementId.slice(0, 8)}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div className="max-w-md truncate text-xs text-muted-foreground" title={alert.detail ?? undefined}>
                        {alert.detail ?? "—"}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 pr-4 text-xs" title={exact(alert.createdAt)}>
                      {relative(alert.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {/*
          Payment reconciliation. It lives here rather than on the payables desk
          because its success condition is showing nothing: the cron runs daily,
          most days produce no exception, and a surface you have to remember to
          visit is the wrong home for something that already emails you. What it
          catches is the case webhooks cannot — a payment that settled without an
          event, or one Arc believes settled that never did.
        */}
        <SectionHeading>Payment reconciliation</SectionHeading>
        <div className="mb-8 border-y">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <p className="text-sm text-muted-foreground">
              {reconciliationExceptions.length === 0
                ? "No open exceptions. Provider records agree with Arc — vendor debits and Arc fee charges both."
                : `${reconciliationExceptions.length} open exception${reconciliationExceptions.length === 1 ? "" : "s"} — provider records disagree with Arc.`}
              {(() => {
                const feeCount = reconciliationExceptions.filter((exception) =>
                  exception.providerReference?.includes("fee_charge"),
                ).length
                return feeCount > 0
                  ? ` ${feeCount} ${feeCount === 1 ? "is an" : "are"} uncollected Arc fee charge${feeCount === 1 ? "" : "s"}.`
                  : null
              })()}
            </p>
            <Button size="sm" variant="outline" disabled={refreshing} onClick={reconcileNow}>
              Reconcile last 24 hours
            </Button>
          </div>
          {reconciliationExceptions.length > 0 ? (
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="pl-4">Kind</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Arc expected</TableHead>
                  <TableHead className="text-right">Provider</TableHead>
                  <TableHead className="text-right">Difference</TableHead>
                  <TableHead className="text-right pr-4">Resolve</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reconciliationExceptions.map((exception) => (
                  <TableRow key={exception.id}>
                    <TableCell className="pl-4 capitalize">{exception.status.replaceAll("_", " ")}</TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-xs">
                      {exception.providerReference ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(exception.expectedCents)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(exception.providerCents)}</TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        exception.differenceCents !== 0 && "text-destructive",
                      )}
                    >
                      {money(exception.differenceCents)}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {resolvingId === exception.id ? (
                        <div className="flex items-center justify-end gap-2">
                          <input
                            autoFocus
                            value={resolveNote}
                            onChange={(event) => setResolveNote(event.target.value)}
                            placeholder="What did you find?"
                            aria-label="Resolution note"
                            className="h-8 w-52 border bg-background px-2 text-xs"
                          />
                          <Button size="sm" disabled={refreshing} onClick={() => resolveException(exception.id)}>
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setResolvingId(null)
                              setResolveNote("")
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setResolvingId(exception.id)
                            setResolveNote("")
                          }}
                        >
                          Resolve
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {reconciliations.length > 0 ? (
            <div className="border-t px-4 py-2 text-xs text-muted-foreground">
              Last run {relative(reconciliations[0].createdAt)} ·{" "}
              <span className="capitalize">{reconciliations[0].status}</span> · difference{" "}
              <span className="tabular-nums">{money(reconciliations[0].differenceCents)}</span>
            </div>
          ) : (
            <p className="border-t px-4 py-6 text-center text-sm text-muted-foreground">
              Reconciliation has not run yet.
            </p>
          )}
        </div>

        {/* QBO connections */}
        <SectionHeading>QuickBooks connections</SectionHeading>
        <div className="mb-8 border-y">
          {qboHealth.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">No organizations have QuickBooks connected.</p>
          ) : (
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="pl-4">Organization</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last sync</TableHead>
                  <TableHead>Refresh token expires</TableHead>
                  <TableHead className="text-right">Refresh failures</TableHead>
                  <TableHead className="pr-4">Last error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {qboHealth.map((conn) => {
                  const refreshExpiry = conn.refreshTokenExpiresAt ? new Date(conn.refreshTokenExpiresAt) : null
                  const refreshExpiringSoon =
                    refreshExpiry !== null && refreshExpiry.getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000
                  return (
                    <TableRow key={conn.orgId}>
                      <TableCell className="pl-4 py-2.5 text-sm font-medium">{conn.orgName}</TableCell>
                      <TableCell className="py-2.5 text-xs text-muted-foreground">{conn.companyName ?? "—"}</TableCell>
                      <TableCell className="py-2.5">
                        <Badge
                          variant={conn.status === "connected" ? "secondary" : "destructive"}
                          className="rounded-none text-[11px]"
                        >
                          {conn.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-2.5 text-xs" title={exact(conn.lastSyncAt)}>
                        {relative(conn.lastSyncAt)}
                      </TableCell>
                      <TableCell
                        className={cn("py-2.5 text-xs", refreshExpiringSoon && "font-medium text-destructive")}
                        title={exact(conn.refreshTokenExpiresAt)}
                      >
                        {conn.refreshTokenExpiresAt ? relative(conn.refreshTokenExpiresAt) : "—"}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "py-2.5 text-right text-xs tabular-nums",
                          conn.refreshFailureCount > 0 ? "font-medium text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {conn.refreshFailureCount}
                      </TableCell>
                      <TableCell className="py-2.5 pr-4">
                        <div className="max-w-xs truncate font-mono text-[11px] text-destructive" title={conn.lastError ?? undefined}>
                          {conn.lastError ?? "—"}
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  )
}

function orgsLabel(group: StuckOutboxHealth["groups"][number]) {
  const hidden = group.orgCount - group.orgNames.length
  const label = group.orgNames.join(", ")
  return hidden > 0 ? `${label} +${hidden} more` : label
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pb-2 pt-5">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</h2>
    </div>
  )
}

function Stat({ label, value, hint, alarm }: { label: string; value: number; hint: string; alarm?: boolean }) {
  return (
    <div className="bg-card px-4 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", alarm && "text-destructive")}>{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function StateBadge({ state }: { state: CronJobHealth["state"] }) {
  return (
    <Badge
      variant={state === "healthy" ? "secondary" : state === "no-data" ? "outline" : "destructive"}
      className="rounded-none text-[11px]"
    >
      <span
        className={cn(
          "mr-1.5 inline-block h-1.5 w-1.5",
          state === "healthy" && "bg-success",
          (state === "failing" || state === "overdue") && "bg-destructive-foreground",
          state === "no-data" && "bg-muted-foreground",
        )}
      />
      {CRON_STATE_LABEL[state]}
    </Badge>
  )
}
