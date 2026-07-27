"use client"

import Link from "next/link"
import { useState } from "react"

import type { PipelineCommunityOption } from "@/components/prospects/prospect-presentation"
import { FindAHomeDialog } from "@/components/sales/find-a-home-dialog"
import type { HoldBuyer } from "@/components/sales/lot-hold-form"
import { PurchaseAgreementSheet } from "@/components/sales/purchase-agreement-sheet"
import { ReserveLotDialog, type ReserveLotTarget } from "@/components/sales/reserve-lot-dialog"
import { Button } from "@/components/ui/button"
import { resolveDealPrimaryAction, type DealPrimaryActionKind } from "@/lib/sales/primary-action"
import type { SalesDeal } from "@/lib/services/sales-deals"

/** The kinds that open a form here rather than navigating somewhere. */
type InPlaceKind = Exclude<DealPrimaryActionKind, "link" | "none">

function isInPlace(kind: DealPrimaryActionKind): kind is InPlaceKind {
  return kind === "find_home" || kind === "reserve" || kind === "agreement"
}

/**
 * The button for the one thing to do next, and the form behind it.
 *
 * The three transitions Sales owns open in place rather than sending the
 * consultant to another desk: matching a buyer to a home, taking the reservation,
 * writing the agreement. The hint that explains the button is printed by the deal
 * file's header, on its own baseline, instead of dangling off the bottom.
 */
export function DealPrimaryAction({
  deal,
  buyer,
  communities,
  reserveTarget,
}: {
  deal: SalesDeal
  buyer: HoldBuyer | null
  communities: PipelineCommunityOption[]
  /** Null when there is no live reservation to reserve or paper. */
  reserveTarget: ReserveLotTarget | null
}) {
  const action = resolveDealPrimaryAction(deal)
  const [openKind, setOpenKind] = useState<InPlaceKind | null>(null)

  if (action.kind === "link") {
    return action.href ? (
      <Button asChild size="sm" className="rounded-none">
        <Link href={action.href}>{action.label}</Link>
      </Button>
    ) : (
      <Button size="sm" className="rounded-none" disabled>
        {action.label}
      </Button>
    )
  }

  // Every in-place action needs a record to act on. No buyer means no lead behind
  // the deal (an imported agreement); no reservation means nothing is held yet.
  const blocked =
    (action.kind === "find_home" && !buyer) ||
    ((action.kind === "reserve" || action.kind === "agreement") && !reserveTarget)

  return (
    <>
      <Button
        size="sm"
        className="rounded-none"
        disabled={blocked || !isInPlace(action.kind)}
        onClick={() => setOpenKind(isInPlace(action.kind) ? action.kind : null)}
      >
        {action.label}
      </Button>

      {buyer ? (
        <FindAHomeDialog
          buyer={buyer}
          communities={communities}
          open={openKind === "find_home"}
          onOpenChange={(next) => setOpenKind(next ? "find_home" : null)}
        />
      ) : null}

      {reserveTarget ? (
        <>
          <ReserveLotDialog
            target={reserveTarget}
            open={openKind === "reserve"}
            onOpenChange={(next) => setOpenKind(next ? "reserve" : null)}
          />
          <PurchaseAgreementSheet
            reservationId={reserveTarget.reservationId}
            open={openKind === "agreement"}
            onOpenChange={(next) => setOpenKind(next ? "agreement" : null)}
          />
        </>
      ) : null}
    </>
  )
}
