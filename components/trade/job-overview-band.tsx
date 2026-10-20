import { StatCell, StatStrip, ThinBar } from "@/components/overview/primitives"
import { Skeleton } from "@/components/ui/skeleton"

export interface TradeJobBandData {
  contractTotalCents: number
  /** Null when the member cannot read invoices. */
  billing: { billedCents: number; collectedCents: number; retainageHeldCents: number } | null
  /** Null when the member cannot read time. */
  crew: { hours: number; periodLabel: string; truncated: boolean } | null
}

const money = (cents: number) =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const percent = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0)
const RESTRICTED = "Not available to your role"

export function TradeJobBand({ contractTotalCents, billing, crew }: TradeJobBandData) {
  const hasContract = contractTotalCents > 0
  return (
    <StatStrip>
      <StatCell
        label="Contract"
        value={hasContract ? money(contractTotalCents) : "—"}
        detail={hasContract ? "Revised value with approved change orders" : "No contract on this job yet"}
        position={0}
      >
        <ThinBar width={hasContract ? 100 : 0} tone="primary" />
      </StatCell>
      <StatCell
        label="Billed"
        value={billing ? money(billing.billedCents) : "—"}
        detail={
          !billing ? RESTRICTED : hasContract
            ? `${percent(billing.billedCents, contractTotalCents)}% of contract`
            : "Nothing billed yet"
        }
        position={1}
      >
        <ThinBar width={billing ? percent(billing.billedCents, contractTotalCents) : 0} tone="primary" />
      </StatCell>
      <StatCell
        label="Paid"
        value={billing ? money(billing.collectedCents) : "—"}
        detail={
          !billing ? RESTRICTED : billing.billedCents > 0
            ? `${percent(billing.collectedCents, billing.billedCents)}% of billed · ${money(Math.max(0, billing.billedCents - billing.collectedCents))} open`
            : "Nothing collected yet"
        }
        position={2}
      >
        <ThinBar width={billing ? percent(billing.collectedCents, billing.billedCents) : 0} tone="primary" />
      </StatCell>
      <StatCell
        label="Retainage held"
        value={billing ? money(billing.retainageHeldCents) : "—"}
        detail={!billing ? RESTRICTED : billing.retainageHeldCents > 0 ? "Held by the customer until release" : "No retainage held"}
        position={3}
      >
        <ThinBar width={billing ? percent(billing.retainageHeldCents, billing.billedCents) : 0} tone="muted" />
      </StatCell>
      <StatCell
        label="Crew hours"
        value={crew ? `${crew.hours.toLocaleString("en-US", { maximumFractionDigits: 2 })} h` : "—"}
        detail={!crew ? RESTRICTED : `${crew.periodLabel}${crew.truncated ? " · at least, older entries not loaded" : ""}`}
        position={4}
      >
        {null}
      </StatCell>
    </StatStrip>
  )
}

export function TradeJobBandSkeleton() {
  return (
    <div className="border-b px-5 sm:px-8 lg:px-12 py-10 grid grid-cols-2 lg:grid-cols-5 gap-x-10 gap-y-8">
      {Array.from({ length: 5 }).map((_, cell) => (
        <div key={cell} className="space-y-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-1 w-full" />
          <Skeleton className="h-3 w-32" />
        </div>
      ))}
    </div>
  )
}
