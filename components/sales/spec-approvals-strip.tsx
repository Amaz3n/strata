"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { toast } from "sonner"

import {
  decideSpecDispositionAction,
  decideSpecPriceChangeAction,
  executeSpecDispositionAction,
} from "@/app/(app)/sales/actions"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { unwrapAction, type ActionResult } from "@/lib/action-result"
import type { SpecApprovalItem } from "@/lib/services/spec-dispositions"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

function describe(item: SpecApprovalItem) {
  if (item.type === "price_change") {
    const what = item.kind === "price" ? "Price" : "Incentive"
    return `${what} ${money.format(item.fromCents / 100)} → ${money.format(item.toCents / 100)}`
  }
  const what = item.kind === "bulk_sale" ? "Bulk sale" : "Investor sale"
  const loss = item.carryingCents > item.priceCents ? ` · ${money.format((item.carryingCents - item.priceCents) / 100)} under cost` : ""
  return `${what} at ${money.format(item.priceCents / 100)}${loss}`
}

/** What the row is waiting on, said plainly when this member cannot act on it. */
function waitingOn(item: SpecApprovalItem) {
  if (item.type === "price_change") return item.canDecide ? null : "Awaiting a second approver"
  if (item.status === "proposed") return item.canDecide ? null : "Awaiting a second approver"
  if (item.blockedReason) return "Write-down awaiting Books approval"
  return item.hasAgreement ? null : "Approved · write the agreement to this buyer"
}

/**
 * Spec price changes and sell-offs waiting on someone, on the Sales desk. The
 * strip is read-mostly: approving, rejecting and recording a sale call the same
 * workbench actions the community's spec inventory uses. It is absent when
 * nothing waits — a row of zeroes is noise a manager learns to skip.
 */
export function SpecApprovalsStrip({ items, truncated }: { items: SpecApprovalItem[]; truncated: boolean }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  if (items.length === 0) return null

  function act(label: string, work: () => Promise<ActionResult<unknown>>) {
    startTransition(async () => {
      try {
        unwrapAction(await work())
        toast.success(label)
        router.refresh()
      } catch (error) {
        toast.error("That did not go through", { description: (error as Error).message })
      }
    })
  }

  return (
    <section className="border" aria-label="Spec approvals">
      <div className="flex items-baseline justify-between gap-4 border-b px-3 py-2">
        <h2 className="microlabel">Spec homes waiting on a decision</h2>
        <p className="text-[11px] text-muted-foreground">
          <span className="tabular-nums text-foreground">{items.length}</span> open
          {truncated ? " · oldest shown first; more are waiting" : null}
        </p>
      </div>
      <ul className="divide-y">
        {items.map((item) => {
          const note = waitingOn(item)
          const offering = `/communities/${item.communityId}/offering`
          return (
            <li key={`${item.type}:${item.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs transition-colors hover:bg-muted/40">
              <Link href={offering} className="w-40 shrink-0 truncate font-medium hover:underline">
                Lot {item.lotLabel}
                {item.communityName ? <span className="ml-1.5 font-normal text-muted-foreground">{item.communityName}</span> : null}
              </Link>
              <span className="tabular-nums">{describe(item)}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={item.reason}>{item.reason}</span>
              {note ? (
                <span className="shrink-0 text-[11px] text-warning">{note}</span>
              ) : item.type === "disposition" && item.status === "approved" ? (
                <Button
                  size="sm"
                  className="h-6 rounded-none px-2 text-[11px]"
                  disabled={isPending}
                  onClick={() => act(`Lot ${item.lotLabel}: sale recorded`, () => executeSpecDispositionAction(item.communityId, { dispositionId: item.id }))}
                >
                  Record sale
                </Button>
              ) : (
                <span className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 rounded-none px-2 text-[11px]"
                    disabled={isPending}
                    onClick={() =>
                      act(
                        `Lot ${item.lotLabel}: rejected`,
                        () => item.type === "price_change"
                          ? decideSpecPriceChangeAction(item.communityId, { proposalId: item.id, approve: false })
                          : decideSpecDispositionAction(item.communityId, { dispositionId: item.id, approve: false }),
                      )}
                  >
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    className="h-6 rounded-none px-2 text-[11px]"
                    disabled={isPending}
                    onClick={() =>
                      act(
                        `Lot ${item.lotLabel}: approved`,
                        () => item.type === "price_change"
                          ? decideSpecPriceChangeAction(item.communityId, { proposalId: item.id, approve: true })
                          : decideSpecDispositionAction(item.communityId, { dispositionId: item.id, approve: true }),
                      )}
                  >
                    Approve
                  </Button>
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The strip's shape while it loads: a header and two rows. */
export function SpecApprovalsStripSkeleton() {
  return (
    <div className="border" aria-hidden>
      <div className="border-b px-3 py-2">
        <Skeleton className="h-3 w-48 rounded-none" />
      </div>
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-4 px-3 py-2">
          <Skeleton className="h-3 w-40 rounded-none" />
          <Skeleton className="h-3 w-32 rounded-none" />
          <Skeleton className="h-3 flex-1 rounded-none" />
        </div>
      ))}
    </div>
  )
}

/** The strip could not load; the board below it still works. */
export function SpecApprovalsStripError() {
  return (
    <p role="alert" className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      Spec approvals could not be loaded. Refresh to try again.
    </p>
  )
}
