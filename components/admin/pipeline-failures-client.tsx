"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { format, formatDistanceToNow } from "date-fns"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { RotateCw } from "@/components/icons"
import { cn } from "@/lib/utils"
import { recommitFailedCutoverAction, requeueFailedPipelineJobAction } from "@/app/(app)/admin/ops/pipelines/actions"
import type { PipelineFailureGroup, PipelineFailureUnit } from "@/lib/services/pipeline-failures"

export function PipelineFailuresClient({ groups }: { groups: PipelineFailureGroup[] }) {
  const router = useRouter()
  const [refreshing, startRefreshing] = useTransition()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const total = groups.reduce((sum, group) => sum + group.total, 0)

  const recover = (unit: PipelineFailureUnit) => {
    const recovery = unit.recovery
    if (!recovery) return
    setBusyKey(unit.key)
    startRefreshing(async () => {
      const result = recovery.kind === "requeue_job"
        ? await requeueFailedPipelineJobAction({ id: recovery.jobId })
        : await recommitFailedCutoverAction({ orgId: unit.orgId, batchId: recovery.batchId })
      if (result.success) {
        toast.success(recovery.kind === "requeue_job" ? `Job #${recovery.jobId} requeued with a fresh retry budget` : "Cutover committed again from its receipts")
        router.refresh()
      } else {
        toast.error(recovery.kind === "requeue_job" ? "Requeue failed" : "Commit again failed", { description: result.error })
      }
      setBusyKey(null)
    })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-semibold">Failed production work</span>
            <span className="text-xs tabular-nums text-muted-foreground">{total} unit{total === 1 ? "" : "s"} across every organization</span>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="h-8 text-xs"><Link href="/admin/ops">All ops</Link></Button>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" disabled={refreshing} onClick={() => startRefreshing(() => router.refresh())}>
              <RotateCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="desk-rise min-h-0 flex-1 overflow-auto">
        {groups.map((group) => (
          <section key={group.pipeline} aria-labelledby={`pipeline-${group.pipeline}`} className="border-b">
            <div className="flex items-baseline gap-3 bg-muted/30 px-4 py-2">
              <h2 id={`pipeline-${group.pipeline}`} className="text-xs font-semibold uppercase tracking-wide">{group.label}</h2>
              <span className={cn("text-xs tabular-nums", group.total ? "text-destructive" : "text-muted-foreground")}>{group.total} failed</span>
            </div>
            {group.units.length === 0 ? (
              <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                Nothing failed. Every {group.label.toLowerCase()} unit finished or retried its way back.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Unit</TableHead>
                    <TableHead>Organization</TableHead>
                    <TableHead>Failed</TableHead>
                    <TableHead>Error</TableHead>
                    <TableHead>Safe recovery</TableHead>
                    <TableHead className="pr-4 text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.units.map((unit) => (
                    <TableRow key={unit.key}>
                      <TableCell className="py-2.5 pl-4 text-xs">
                        {unit.href ? <Link href={unit.href} className="font-medium hover:underline">{unit.label}</Link> : <span className="font-medium">{unit.label}</span>}
                        {unit.correlationId ? <div className="mt-0.5 max-w-56 truncate font-mono text-[11px] text-muted-foreground" title={`Correlation id: ${unit.correlationId}`}>{unit.correlationId}</div> : null}
                      </TableCell>
                      <TableCell className="py-2.5 text-xs">{unit.orgName ?? "—"}</TableCell>
                      <TableCell className="py-2.5 text-xs whitespace-nowrap" title={format(new Date(unit.failedAt), "MMM d, HH:mm:ss")}>
                        {formatDistanceToNow(new Date(unit.failedAt), { addSuffix: true })}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <div className="max-w-xs truncate font-mono text-[11px] text-destructive" title={unit.error ?? undefined}>{unit.error ?? "—"}</div>
                      </TableCell>
                      <TableCell className="max-w-md py-2.5 text-xs text-muted-foreground">{unit.cure}</TableCell>
                      <TableCell className="py-2.5 pr-4 text-right">
                        {unit.recovery ? (
                          <Button variant="outline" size="sm" className="h-7 text-xs" disabled={busyKey !== null} onClick={() => recover(unit)}>
                            {busyKey === unit.key ? "Working…" : unit.recovery.kind === "requeue_job" ? "Requeue" : "Commit again"}
                          </Button>
                        ) : unit.href ? (
                          <Button asChild variant="ghost" size="sm" className="h-7 text-xs"><Link href={unit.href}>Open</Link></Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {group.total > group.units.length ? (
              <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                Showing the {group.units.length} most recent of {group.total} failed {group.label.toLowerCase()} units.
              </p>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  )
}
