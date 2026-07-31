import { InlineStat } from "@/components/communities/inline-stat"
import type { CommunityLane } from "@/lib/services/community-portfolio"

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Supply is the land manager's number, so its tone follows the runway verdict. */
const VERDICT_TONE: Record<CommunityLane["verdict"], string> = {
  dry: "text-destructive",
  stalled: "text-warning",
  tight: "text-warning",
  opening: "text-muted-foreground",
  holds: "text-foreground",
  closing: "text-muted-foreground",
}

const PACE_TONE: Record<CommunityLane["paceState"], string> = {
  ahead: "text-success",
  on: "text-foreground",
  behind: "text-destructive",
  unknown: "text-foreground",
}

/** Months from today, rendered as the calendar month a builder actually says. */
function monthFromNow(months: number) {
  const date = new Date()
  date.setMonth(date.getMonth() + Math.round(months))
  return `${MONTH_LABELS[date.getMonth()]} '${String(date.getFullYear()).slice(2)}`
}

/**
 * The four numbers a production builder manages a community by: how much is
 * left to sell, how long it lasts, whether it is selling fast enough, and
 * whether it is making money. The old header carried four flavours of lot count,
 * none of which had time in them.
 */
export function CommunityHeaderStats({
  lane,
  plannedLotCount,
}: {
  lane: CommunityLane | null
  plannedLotCount: number | null
}) {
  // A failed lane used to delete the four numbers the page exists for, with no
  // trace that they were ever meant to be there.
  if (!lane) {
    return (
      <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 py-2">
        {["Sellable", "Supply", "Pace", "Margin"].map((label) => (
          <InlineStat key={label} label={label} value="—" />
        ))}
      </dl>
    )
  }

  const supply =
    lane.dryAtMonth != null
      ? { value: `dry ${monthFromNow(lane.dryAtMonth)}`, hint: undefined }
      : lane.monthsOfSupply != null
        ? { value: `${lane.monthsOfSupply.toFixed(1)} mo`, hint: undefined }
        : { value: "—", hint: "no start rate" }

  return (
    <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 py-2">
      <InlineStat
        label="Sellable"
        value={String(lane.sellableLots)}
        hint={`of ${plannedLotCount ?? lane.totalLots}`}
      />
      <InlineStat label="Supply" value={supply.value} hint={supply.hint} tone={VERDICT_TONE[lane.verdict]} />
      <InlineStat
        label="Pace"
        value={
          lane.requiredPacePerMonth != null
            ? `${lane.salesPacePerMonth.toFixed(1)} / ${lane.requiredPacePerMonth.toFixed(1)}`
            : lane.salesPacePerMonth.toFixed(1)
        }
        hint={lane.requiredPacePerMonth == null ? "no target" : undefined}
        tone={PACE_TONE[lane.paceState]}
      />
      {lane.marginPercent != null ? (
        <InlineStat
          label="Margin"
          value={`${lane.marginPercent.toFixed(1)}%`}
          hint={lane.targetMarginPercent != null ? `vs ${lane.targetMarginPercent.toFixed(1)}%` : undefined}
          tone={
            lane.targetMarginPercent != null && lane.marginPercent < lane.targetMarginPercent
              ? "text-destructive"
              : undefined
          }
        />
      ) : null}
    </dl>
  )
}
