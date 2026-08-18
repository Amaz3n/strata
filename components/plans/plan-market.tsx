"use client"

import Link from "next/link"
import { useMemo } from "react"

import { ExternalLink, MoreHorizontal } from "@/components/icons"
import { centsToDollars } from "@/components/plans/plan-badges"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LOT_STATUS_META } from "@/lib/land/lot-lifecycle"
import { MARGIN_BAND_META, marginBand } from "@/lib/plans/margin"
import type { OfferingRow } from "@/lib/plans/offering"
import type { CommunityListItemDTO } from "@/lib/services/communities"
import type { HousePlanDto } from "@/lib/services/house-plans"
import { cn } from "@/lib/utils"

/**
 * Where the plan sells and where it stands, one row per community. Offering and
 * footprint were two sections at opposite ends of the page asking the same
 * question — a sales manager wants the price and the margin, a land manager wants
 * the lots, and both of them mean "how is this plan doing at Cypress Landing".
 *
 * Read-only. The plan library owns the *product*; whether a community sells it,
 * and for what, is the sales manager's decision and is made on that community's
 * Offering tab. Both used to write `community_plan_availability`, which needed a
 * rule quietly discarding one caller's price to stop them fighting.
 */
export function PlanMarket({
  plan,
  rows,
  communities,
}: {
  plan: HousePlanDto
  rows: OfferingRow[]
  communities: CommunityListItemDTO[]
}) {
  const elevations = useMemo(() => (plan.elevations ?? []).filter((elevation) => elevation.is_active), [plan.elevations])
  const columns = useMemo(() => [null, ...elevations.map((elevation) => elevation.id)], [elevations])


  return (
    <section id="plan-markets" className="scroll-mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 px-4 pb-2 pt-3.5">
        <div>
          <h3 className="text-sm font-medium">Markets</h3>
          <p className="text-[11px] text-muted-foreground">{rows.length} community relationships</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          {communities.length === 0
            ? "No communities yet. Create one, then offer this plan from its Offering tab."
            : "This plan is not offered anywhere and no lot carries it. Offer it from a community's Offering tab to put it on a price sheet."}
        </p>
      ) : (
        <div className="divide-y border-t">
          {rows.map((row) => {
            const band = marginBand(row.marginPct)
            const offered = row.cells.filter((cell) => cell.offered)
            return (
              <div
                key={row.communityId}
                className="grid gap-x-4 gap-y-2 px-4 py-3 lg:grid-cols-[minmax(140px,1.1fr)_130px_120px_70px_minmax(140px,1fr)_auto]"
              >
                <div className="min-w-0">
                  <Link href={`/communities/${row.communityId}`} className="text-xs font-medium hover:underline">
                    {row.communityName}
                  </Link>
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                    {offered.length > 0
                      ? `${offered.map((cell) => cell.code).join(", ")} offered`
                      : "not offered — lots only"}
                  </p>
                </div>

                <div className="text-xs tabular-nums">
                  {row.priceCents == null ? (
                    <span className="text-warning">{row.offered ? "no price" : "—"}</span>
                  ) : (
                    <>
                      {centsToDollars(row.priceCents)}
                      {row.priceMaxCents != null && row.priceMaxCents !== row.priceCents ? (
                        <span className="block text-[10px] text-muted-foreground">
                          to {centsToDollars(row.priceMaxCents)}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>

                <div className="text-xs tabular-nums text-muted-foreground">
                  {row.buildCents != null ? `${centsToDollars(row.buildCents)} build` : "no build cost"}
                  <span className="block text-[10px]">
                    {row.lotBasisCents != null ? `${centsToDollars(row.lotBasisCents)} lot` : "no lot basis"}
                  </span>
                </div>

                <div className={cn("text-xs font-medium tabular-nums", MARGIN_BAND_META[band].text)}>
                  {row.marginPct != null ? `${Math.round(row.marginPct)}%` : "—"}
                </div>

                <div className="min-w-0">
                  {row.lotTotal > 0 ? (
                    <>
                      <div className="flex h-1.5 w-full overflow-hidden border">
                        {row.lotCounts.map((entry) => (
                          <span
                            key={entry.status}
                            className={LOT_STATUS_META[entry.status]?.barClass ?? "bg-muted"}
                            style={{ width: `${(entry.count / row.lotTotal) * 100}%` }}
                            title={`${LOT_STATUS_META[entry.status]?.label ?? entry.status}: ${entry.count}`}
                          />
                        ))}
                      </div>
                      <p className="mt-1 flex flex-wrap gap-x-2.5 text-[10px] tabular-nums text-muted-foreground">
                        {row.lotCounts.map((entry) => (
                          <span key={entry.status}>
                            {LOT_STATUS_META[entry.status]?.label ?? entry.status} {entry.count}
                          </span>
                        ))}
                      </p>
                    </>
                  ) : (
                    <p className="text-[10px] text-muted-foreground">No lots carry this plan here yet.</p>
                  )}
                </div>

                <div className="flex items-start justify-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 rounded-none"
                        aria-label={`Actions for ${row.communityName}`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={`/communities/${row.communityId}/offering`}>
                          <ExternalLink className="h-4 w-4" />
                          Open offering
                        </Link>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            )
          })}
        </div>
      )}

    </section>
  )
}
