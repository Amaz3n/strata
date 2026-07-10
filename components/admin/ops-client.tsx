"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { RotateCw } from "@/components/icons"
import { cn } from "@/lib/utils"
import { retryAllFailedOutboxAction, retryOutboxItemAction } from "@/app/(app)/admin/ops/actions"
import type { CronJobHealth, OutboxHealth, QboConnectionHealth } from "@/lib/services/ops"

interface OpsClientProps {
  cronHealth: CronJobHealth[]
  outboxHealth: OutboxHealth
  qboHealth: QboConnectionHealth[]
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

export function OpsClient({ cronHealth, outboxHealth, qboHealth }: OpsClientProps) {
  const router = useRouter()
  const [refreshing, startRefreshing] = useTransition()
  const [retryingId, setRetryingId] = useState<number | null>(null)
  const [retryingAll, startRetryingAll] = useTransition()

  const overdueCount = cronHealth.filter((job) => job.state === "overdue").length
  const failingCount = cronHealth.filter((job) => job.state === "failing").length
  const qboErrorCount = qboHealth.filter(
    (conn) => conn.lastError || conn.status !== "connected" || conn.refreshFailureCount > 0,
  ).length

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

      <div className="relative z-10 min-h-0 flex-1 overflow-auto">
        {/* Stat strip */}
        <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-5">
          <Stat label="Overdue crons" value={overdueCount} alarm={overdueCount > 0} hint="past 2× cadence" />
          <Stat label="Failing crons" value={failingCount} alarm={failingCount > 0} hint="last run errored" />
          <Stat label="Outbox failed" value={outboxHealth.failedCount} alarm={outboxHealth.failedCount > 0} hint="need attention" />
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
          {outboxHealth.failedCount > 0 ? (
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={retryingAll} onClick={handleRetryAll}>
              {retryingAll ? "Retrying…" : `Retry all failed (${outboxHealth.failedCount})`}
            </Button>
          ) : null}
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
