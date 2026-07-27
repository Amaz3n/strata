import Link from "next/link"

import { Home } from "@/components/icons"
import { BAND_X } from "@/components/overview/primitives"
import { Badge } from "@/components/ui/badge"
import { STAGE_ACCENT, STAGE_LABELS } from "@/lib/sales/stages"
import type { SalesDeal } from "@/lib/services/sales-deals"
import { cn } from "@/lib/utils"

/** Two letters for the tile: first and last name, or the first two characters. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

/**
 * Who this is, where they are buying, and the one button that moves them along.
 *
 * Built to the project overview's header so a home file and a deal file open the
 * same way. The tile carries the stage accent and the badge names it, which is
 * how the colour gets a legend instead of being decoration.
 *
 * A server component: the two controls are client islands passed in as
 * `actions`, so the header itself never crosses the boundary.
 */
export function DealOverviewHeader({
  deal,
  hint,
  actions,
}: {
  deal: SalesDeal
  /** Why the primary action is the primary action. */
  hint: string
  actions: React.ReactNode
}) {
  const accent = STAGE_ACCENT[deal.stage]
  const home = [deal.communityName, deal.lotLabel ? `Lot ${deal.lotLabel}` : null, deal.planName]
    .filter(Boolean)
    .join(" · ")

  return (
    <header className="border-b">
      {/* Stacks on phones: at 375px a name, a stage chip and two buttons cannot
          share a row without one of them being crushed to nothing. */}
      <div className={cn(BAND_X, "flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:gap-4")}>
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <span
            aria-hidden
            className={cn(
              "flex size-12 shrink-0 items-center justify-center border text-sm font-semibold tracking-tight",
              accent.chip,
            )}
          >
            {initialsOf(deal.buyerName)}
          </span>

          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 className="truncate text-xl leading-tight font-semibold tracking-tight sm:text-2xl">
                {deal.buyerName}
              </h1>
              <Badge
                variant="secondary"
                className={cn("shrink-0 rounded-none border font-normal", accent.chip)}
              >
                {STAGE_LABELS[deal.stage]}
              </Badge>
            </div>
            {home ? (
              deal.communityId ? (
                <Link
                  href={`/communities/${deal.communityId}`}
                  className="mt-1.5 inline-flex max-w-full min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Home className="h-3 w-3 shrink-0" />
                  <span className="truncate">{home}</span>
                </Link>
              ) : (
                <p className="mt-1.5 truncate text-xs text-muted-foreground">{home}</p>
              )
            ) : (
              <p className="mt-1.5 text-xs text-muted-foreground">No home selected yet</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-1.5 sm:items-end">
          <div className="flex items-center gap-2">{actions}</div>
          {/* Dropped on phones, where the buttons already fill the row. */}
          <p className="hidden max-w-80 text-right text-xs text-muted-foreground sm:block">{hint}</p>
        </div>
      </div>
    </header>
  )
}
