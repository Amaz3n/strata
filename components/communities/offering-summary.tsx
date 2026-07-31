import Link from "next/link"

import { InlineStat } from "@/components/communities/inline-stat"
import { Button } from "@/components/ui/button"
import { MARGIN_BAND_META, marginBand } from "@/lib/plans/margin"
import { HEAVY_GIVE_PCT } from "@/lib/sales/offering"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

export type OfferingSummaryProps = {
  planCount: number
  libraryPlanCount: number
  /** Advertised low: cheapest net price plus the cheapest lot premium. */
  fromCents: number | null
  topCents: number | null
  minPremiumCents: number
  maxPremiumCents: number
  averageGiveCents: number
  givePercent: number | null
  designCreditCents: number
  /** Thinnest gross margin on the sheet, null when margin is not readable. */
  thinnestMarginPercent: number | null
  asOfDate: string
}

/**
 * What the offer *is*, in one line — the answer a sales manager wants before
 * reading a single row: what it spans, how much of the library is working here,
 * what is being given away, and how much room is left underneath.
 */
export function OfferingSummary({
  planCount,
  libraryPlanCount,
  fromCents,
  topCents,
  minPremiumCents,
  maxPremiumCents,
  averageGiveCents,
  givePercent,
  designCreditCents,
  thinnestMarginPercent,
  asOfDate,
}: OfferingSummaryProps) {
  const heavyGive = givePercent != null && givePercent >= HEAVY_GIVE_PCT
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b bg-muted/30 px-4 py-2.5">
      <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <InlineStat
          label="From"
          value={fromCents == null ? "—" : money.format(fromCents / 100)}
          hint={topCents != null && topCents !== fromCents ? `to ${money.format(topCents / 100)}` : undefined}
        />
        <InlineStat label="Plans" value={String(planCount)} hint={`of ${libraryPlanCount} in the library`} />
        <InlineStat
          label="Premiums"
          value={
            maxPremiumCents > 0
              ? `${money.format(minPremiumCents / 100)}–${money.format(maxPremiumCents / 100)}`
              : "none"
          }
        />
        <InlineStat
          label="Give"
          value={averageGiveCents > 0 ? money.format(averageGiveCents / 100) : "none"}
          hint={givePercent != null && givePercent > 0 ? `${givePercent.toFixed(1)}% of base` : undefined}
          tone={heavyGive ? "text-warning" : undefined}
        />
        {designCreditCents > 0 ? (
          <InlineStat label="Design credit" value={money.format(designCreditCents / 100)} />
        ) : null}
        {thinnestMarginPercent != null ? (
          <InlineStat
            label="Thinnest"
            value={`${Math.round(thinnestMarginPercent)}%`}
            hint="gross"
            tone={MARGIN_BAND_META[marginBand(thinnestMarginPercent)].text}
          />
        ) : null}
      </dl>
      <div className="ml-auto flex items-center gap-3">
        <span className="text-[11px] tabular-nums text-muted-foreground">as of {asOfDate}</span>
        <Button asChild variant="outline" size="sm" className="h-7 rounded-none text-xs">
          <Link href="/plans">Plan library</Link>
        </Button>
      </div>
    </div>
  )
}
