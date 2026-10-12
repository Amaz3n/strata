import Link from "next/link"

import { SpecHomeActions, type SpecHomeActionRow } from "@/components/communities/spec-home-actions"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { SpecPriceApprovalBand } from "@/lib/sales/spec-price-approval-thresholds"

export interface SpecRow extends SpecHomeActionRow {
  planLabel: string
  beds: number | null
  baths: number | null
  sqft: number | null
  agingDays: number
  underConstruction: boolean
  incentiveExpiresOn: string | null
  pendingChange: (SpecHomeActionRow["pendingChange"] & { kind: "price" | "incentive"; toCents: number }) | null
  disposition: (SpecHomeActionRow["disposition"] & { kind: "bulk_sale" | "investor_sale" }) | null
}

/** Past this a standing spec is a pricing problem, not an inventory position. */
const AGING_ALERT_DAYS = 90
/** Where a spec stops being new and starts being watched. */
const AGING_WATCH_DAYS = 60

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

const DISPOSITION_LABELS = { bulk_sale: "Bulk sale", investor_sale: "Investor sale" } as const

/** Fresh, watched, stale — the three ages a standing house is managed by. */
function ageTone(days: number) {
  if (days >= AGING_ALERT_DAYS) return "text-age-2"
  if (days >= AGING_WATCH_DAYS) return "text-age-1"
  return "text-muted-foreground"
}

/** How long the home has stood, or why there is no age to show. */
function StandingCell({ row }: { row: SpecRow }) {
  if (row.underConstruction) return <span className="text-muted-foreground">Building</span>
  if (!row.completedAt) return <span className="text-warning">Completion not recorded</span>
  return <span className={ageTone(row.agingDays)}>{row.agingDays}d</span>
}

/** What the home is waiting on: a move for approval, or a sale-off in flight. */
function StateNote({ row }: { row: SpecRow }) {
  if (row.disposition) {
    const label = DISPOSITION_LABELS[row.disposition.kind]
    const state = row.disposition.status === "proposed"
      ? "awaiting approval"
      : row.disposition.blockedReason
        ? "approved · write-down pending"
        : "approved · write the agreement"
    return (
      <span className="block text-[11px] text-chart-1">
        {label} {money.format(row.disposition.priceCents / 100)} · {state}
      </span>
    )
  }
  if (row.pendingChange) {
    const what = row.pendingChange.kind === "price" ? "Price" : "Incentive"
    return (
      <span className="block text-[11px] text-warning">
        {what} → {money.format(row.pendingChange.toCents / 100)} awaiting approval
      </span>
    )
  }
  return null
}

/**
 * Homes standing unsold in this community, oldest first. Aging is the sales
 * manager's second lever after price, and it is the reason a spec gets an
 * incentive rather than a discount. A finished home with no recorded completion
 * says so instead of looking new.
 *
 * Specs are released from Starts and sold from the Sales desk; the writes here
 * are a manager's moves on one house — its price, its own incentive, its
 * completion date, or selling it off.
 */
export function CommunitySpecInventory({
  rows,
  communityId,
  canManage,
  currentUserId,
  bands,
}: {
  rows: SpecRow[]
  communityId: string
  canManage: boolean
  currentUserId: string
  bands: SpecPriceApprovalBand[]
}) {
  const sorted = [...rows].sort((a, b) => b.agingDays - a.agingDays)
  const aging = sorted.filter((row) => row.agingDays >= AGING_ALERT_DAYS).length
  const unrecorded = sorted.filter((row) => !row.underConstruction && !row.completedAt).length
  const standingValue = sorted.reduce((sum, row) => sum + (row.askingPriceCents ?? 0), 0)

  return (
    <section className="border">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-4 py-2.5">
        <h2 className="microlabel">Standing inventory</h2>
        <p className="text-[11px] text-muted-foreground">
          {sorted.length === 0 ? (
            "nothing unsold"
          ) : (
            <>
              <span className="tabular-nums text-foreground">{sorted.length}</span> unsold ·{" "}
              <span className="tabular-nums text-foreground">{money.format(standingValue / 100)}</span> asking
              {aging > 0 ? (
                <>
                  {" · "}
                  <span className="font-medium tabular-nums text-age-2">{aging}</span> over {AGING_ALERT_DAYS} days
                </>
              ) : null}
              {unrecorded > 0 ? (
                <>
                  {" · "}
                  <span className="font-medium tabular-nums text-warning">{unrecorded}</span> completion not recorded
                </>
              ) : null}
            </>
          )}
        </p>
      </div>
      {sorted.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          No unsold specs standing here. Everything started has a buyer.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="microlabel hover:bg-transparent">
                <TableHead>Lot</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Sq ft</TableHead>
                <TableHead className="text-right">Asking</TableHead>
                <TableHead className="text-right">$/sf</TableHead>
                <TableHead className="text-right">Standing</TableHead>
                {canManage ? <TableHead className="w-8" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row) => (
                <TableRow key={row.lotId} className="text-xs">
                  <TableCell className="font-medium tabular-nums">
                    {row.projectId ? (
                      <Link href={`/projects/${row.projectId}`} className="hover:underline">
                        {row.lotLabel}
                      </Link>
                    ) : (
                      row.lotLabel
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.planLabel}
                    {row.beds != null || row.baths != null ? (
                      <span className="ml-1.5 tabular-nums text-muted-foreground/70">
                        {row.beds ?? "—"}/{row.baths ?? "—"}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {row.sqft?.toLocaleString() ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {row.askingPriceCents != null ? money.format(row.askingPriceCents / 100) : <span className="font-normal text-muted-foreground">Unpriced</span>}
                    {row.incentiveCents > 0 ? (
                      <span className="block text-[11px] font-normal text-success">
                        −{money.format(row.incentiveCents / 100)} incentive{row.incentiveExpiresOn ? ` to ${row.incentiveExpiresOn}` : ""}
                      </span>
                    ) : null}
                    <StateNote row={row} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {row.sqft && row.askingPriceCents ? `$${Math.round(row.askingPriceCents / 100 / row.sqft)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <StandingCell row={row} />
                  </TableCell>
                  {canManage ? (
                    <TableCell className="text-right">
                      <SpecHomeActions row={row} communityId={communityId} currentUserId={currentUserId} bands={bands} />
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}
