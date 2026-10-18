import { QueuePagination } from "@/components/layout/queue-pagination"
import { Skeleton } from "@/components/ui/skeleton"
import { TradeResponseQueue } from "@/components/schedule/trade-response-queue"
import { requireOrgContext } from "@/lib/services/context"
import { hasPermission } from "@/lib/services/permissions"
import { listOpenTradeResponses } from "@/lib/services/trade-responses"

export function TradeResponseBandSkeleton() {
  return <div className="border p-3" aria-busy role="status" aria-label="Loading trade answers"><Skeleton className="h-4 w-40" /><Skeleton className="mt-3 h-10 w-full" /></div>
}

/**
 * Trades' declines and requests for other dates, oldest first. The desk reads
 * and routes; closing an answer calls the workbench services (the bulk schedule
 * move for new dates), so there is one way to change a date.
 */
export async function TradeResponseBand({ page, communityId, href }: { page: number; communityId?: string; href: string }) {
  const context = await requireOrgContext()
  if (!await hasPermission("start.write", context)) return null
  const [queue, canSchedule] = await Promise.all([
    listOpenTradeResponses({ page, communityId }, context.orgId),
    hasPermission("schedule.edit", context),
  ])
  return (
    <section className="border" aria-label="Trade answers waiting">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-medium">Trade answers waiting</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{queue.total} open</span>
      </div>
      <TradeResponseQueue rows={queue.rows} canSchedule={canSchedule} />
      {queue.total > queue.pageSize && <QueuePagination page={page} pageSize={queue.pageSize} total={queue.total} href={href} pageParam="responsePage" label="Trade answer pages" />}
    </section>
  )
}
