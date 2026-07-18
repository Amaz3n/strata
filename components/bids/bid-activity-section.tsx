"use client"

import { formatDistanceToNow } from "date-fns"

import type { BidActivityItem } from "@/lib/services/bids"
import { activityActor, activityLabel } from "@/components/bids/bid-workbench-helpers"

export function BidActivitySection({ activity }: { activity: BidActivityItem[] }) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">Activity</h2>
      {activity.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No activity yet.
        </div>
      ) : (
        <ol className="space-y-2">
          {activity.map((event) => {
            const actor = activityActor(event.payload)
            return (
              <li key={event.id} className="flex items-baseline justify-between gap-3 text-sm">
                <span>
                  <span className="font-medium">{activityLabel(event.event_type)}</span>
                  {actor ? <span className="text-muted-foreground"> · {actor}</span> : null}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
