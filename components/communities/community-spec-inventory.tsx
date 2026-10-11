import Link from "next/link"

import { SpecRepriceDialog } from "@/components/communities/spec-reprice-dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export interface SpecRow {
  lotId: string
  lotLabel: string
  projectId: string | null
  planLabel: string
  beds: number | null
  baths: number | null
  sqft: number | null
  agingDays: number
  askingPriceCents: number | null
}

/** Past this a standing spec is a pricing problem, not an inventory position. */
const AGING_ALERT_DAYS = 90
/** Where a spec stops being new and starts being watched. */
const AGING_WATCH_DAYS = 60

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

/** Fresh, watched, stale — the three ages a standing house is managed by. */
function ageTone(days: number) {
  if (days >= AGING_ALERT_DAYS) return "text-age-2"
  if (days >= AGING_WATCH_DAYS) return "text-age-1"
  return "text-muted-foreground"
}

/**
 * Homes standing unsold in this community, oldest first. Aging is the sales
 * manager's second lever after price, and it is the reason a spec gets an
 * incentive rather than a discount.
 *
 * Specs are released from Starts and sold from the Sales desk; the only write
 * here is a manager moving one house's asking price.
 */
export function CommunitySpecInventory({ rows, communityId, canManage }: { rows: SpecRow[]; communityId: string; canManage: boolean }) {
  const sorted = [...rows].sort((a, b) => b.agingDays - a.agingDays)
  const aging = sorted.filter((row) => row.agingDays >= AGING_ALERT_DAYS).length
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
                {canManage ? <TableHead className="w-16" /> : null}
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
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {row.sqft && row.askingPriceCents ? `$${Math.round(row.askingPriceCents / 100 / row.sqft)}` : "—"}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", ageTone(row.agingDays))}>
                    {row.agingDays}d
                  </TableCell>
                  {canManage ? (
                    <TableCell className="text-right">
                      {row.askingPriceCents != null ? (
                        <SpecRepriceDialog
                          communityId={communityId}
                          lotId={row.lotId}
                          lotLabel={row.lotLabel}
                          askingPriceCents={row.askingPriceCents}
                        />
                      ) : null}
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
