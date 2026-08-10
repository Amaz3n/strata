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
import { requeueDrawingsPipelineJobAction } from "@/app/(app)/admin/ops/drawings/actions"
import type { DrawingsDeadLetterHealth } from "@/lib/services/ops"

interface DrawingsDeadLetterClientProps {
  health: DrawingsDeadLetterHealth
}

function relative(value: string | null) {
  return value ? formatDistanceToNow(new Date(value), { addSuffix: true }) : "—"
}

function exact(value: string | null) {
  return value ? format(new Date(value), "MMM d, HH:mm:ss") : undefined
}

export function DrawingsDeadLetterClient({ health }: DrawingsDeadLetterClientProps) {
  const router = useRouter()
  const [refreshing, startRefreshing] = useTransition()
  const [requeueingId, setRequeueingId] = useState<number | null>(null)

  const handleRequeue = (id: number) => {
    setRequeueingId(id)
    startRefreshing(async () => {
      const result = await requeueDrawingsPipelineJobAction({ id })
      if (result.success) {
        toast.success(`Job #${id} requeued with a fresh retry budget`)
        router.refresh()
      } else {
        toast.error("Requeue failed", { description: result.error })
      }
      setRequeueingId(null)
    })
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      <div className="relative z-20 shrink-0 border-b bg-background/95 px-4 py-3 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-semibold">Drawings pipeline dead letters</span>
            <span className="text-xs text-muted-foreground">
              {health.totalFailed} failed · retries exhausted
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="h-8 text-xs">
              <Link href="/admin/ops">All ops</Link>
            </Button>
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
        <div className="border-b">
          {health.items.length === 0 ? (
            <p className="flex items-center justify-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
              No dead-lettered drawings jobs. Every failure retried its way back to health.
            </p>
          ) : (
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="pl-4">ID</TableHead>
                  <TableHead>Job type</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Sheet</TableHead>
                  <TableHead>Payload</TableHead>
                  <TableHead className="text-right">Retries</TableHead>
                  <TableHead>Failed</TableHead>
                  <TableHead>Last error</TableHead>
                  <TableHead className="pr-4 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {health.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="pl-4 py-2.5 font-mono text-xs tabular-nums">{item.id}</TableCell>
                    <TableCell className="py-2.5 font-mono text-xs">{item.jobType}</TableCell>
                    <TableCell className="py-2.5 text-xs">{item.orgName ?? "—"}</TableCell>
                    <TableCell className="py-2.5 text-xs">
                      <div className="max-w-40 truncate" title={item.projectName ?? undefined}>
                        {item.projectName ?? "—"}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 text-xs">{item.sheetLabel ?? "—"}</TableCell>
                    <TableCell className="py-2.5 font-mono text-[11px] text-muted-foreground">
                      {item.payloadSummary}
                    </TableCell>
                    <TableCell className="py-2.5 text-right text-xs tabular-nums">{item.retryCount}</TableCell>
                    <TableCell
                      className="py-2.5 text-xs whitespace-nowrap"
                      title={exact(item.failedAt)}
                    >
                      {relative(item.failedAt)}
                    </TableCell>
                    <TableCell className="py-2.5">
                      <div
                        className="max-w-sm truncate font-mono text-[11px] text-destructive"
                        title={item.lastError ?? undefined}
                      >
                        {item.lastError ?? "—"}
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 pr-4 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={requeueingId === item.id}
                        onClick={() => handleRequeue(item.id)}
                      >
                        {requeueingId === item.id ? "Requeueing…" : "Requeue"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {health.totalFailed > health.items.length ? (
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              Showing the {health.items.length} most recent of {health.totalFailed} failed jobs —
              requeue clears rows off the top of this list.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
