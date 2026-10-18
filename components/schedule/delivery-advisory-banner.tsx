import Link from "next/link"
import { Truck } from "lucide-react"

import { formatDay, formatQuantity } from "@/components/purchasing/delivery-format"
import { ReceiveDeliveryButton } from "@/components/purchasing/receive-delivery-button"
import { Skeleton } from "@/components/ui/skeleton"
import { listHomeDeliveryAdvisories } from "@/lib/services/po-receipts"

const SHOWN = 4

export function DeliveryAdvisoryBannerSkeleton() {
  return <div className="border-b px-4 py-2" aria-busy role="status" aria-label="Checking deliveries"><Skeleton className="h-4 w-56" /></div>
}

/**
 * Tasks a late, short or back-ordered delivery puts at risk, matched on cost
 * code. An advisory only: the schedule is not changed, and a coordinator decides
 * whether the task moves. Renders nothing when the reader cannot see deliveries
 * or nothing is at risk.
 */
export async function DeliveryAdvisoryBanner({ projectId }: { projectId: string }) {
  const advisories = await listHomeDeliveryAdvisories(projectId).catch(() => "failed" as const)
  if (advisories === "failed") {
    return <section role="alert" className="border-b bg-warning/5 px-4 py-2 text-xs text-muted-foreground">
      Delivery advisories could not be loaded. The schedule is unaffected; reload to check late deliveries.
    </section>
  }
  if (!advisories?.length) return null
  const shown = advisories.slice(0, SHOWN)
  return <section aria-label="Deliveries that put scheduled work at risk" className="border-b bg-warning/5 px-4 py-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-medium"><Truck className="size-4 text-warning" /> {advisories.length} {advisories.length === 1 ? "delivery puts" : "deliveries put"} scheduled work at risk</h2>
      <div className="flex items-center gap-1">
        <ReceiveDeliveryButton projectId={projectId} label="Receive delivery" />
        <Link href={`/purchasing?tab=deliveries&project=${projectId}`} className="px-2 text-xs text-muted-foreground underline underline-offset-4">Deliveries desk</Link>
      </div>
    </div>
    <ul className="mt-1 grid gap-0.5 text-xs">
      {shown.map((advisory) => <li key={`${advisory.scheduleItemId}:${advisory.lineId}`} className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{advisory.scheduleItemName}</span>
        <span className="text-muted-foreground">starts {formatDay(advisory.startDate)}</span>
        <span>{formatQuantity(advisory.outstanding)} {advisory.unit} {advisory.description} {advisory.daysLate > 0 ? <span className="tabular-nums text-destructive">{advisory.daysLate} days late</span> : <span className="text-muted-foreground">expected {formatDay(advisory.expectedDate)}</span>}</span>
      </li>)}
    </ul>
    {advisories.length > shown.length && <p className="mt-1 text-xs text-muted-foreground">And {advisories.length - shown.length} more.</p>}
  </section>
}
