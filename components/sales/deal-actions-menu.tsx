"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

import { deleteDealAction, reopenDealAction } from "@/app/(app)/sales/actions"
import { MoreHorizontal } from "@/components/icons"
import { EditDealSheet, type DealEditable } from "@/components/sales/edit-deal-sheet"
import { MarkLostDialog } from "@/components/sales/mark-lost-dialog"
import { ReleaseReservationDialog } from "@/components/sales/release-reservation-dialog"
import { VoidAgreementDialog } from "@/components/sales/void-agreement-dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"

interface DealActionsMenuProps {
  deal: DealEditable
  teamMembers: { id: string; name: string }[]
  /** For re-homing a lead that has not been matched to a lot yet. */
  communities: { id: string; name: string }[]
  isLost: boolean
  /** Settled deals cannot be lost or deleted — the money already moved. */
  isClosed: boolean
  /**
   * A lead that never became a house. Anything with a job behind it keeps its
   * history and gets marked lost instead, which is also what the service enforces.
   */
  isDeletable: boolean
  /**
   * The live reservation, when there is one. Releasing it is the only thing that
   * puts a lot back on the shelf — marking a deal lost closes the lead and leaves
   * the lot held, which is how a community loses homes it cannot explain.
   */
  reservation: { id: string; lotLabel: string | null; hasDeposit: boolean } | null
  /** A draft or executed agreement that can still be unwound. */
  agreement: { contractId: string; hasDeposit: boolean } | null
}

/**
 * Everything you can do to a deal that is not the next thing to do.
 *
 * The stage-gated primary action stays a button — it is the whole point of the
 * page and must never be a click away. What collects here is the occasional and
 * the terminal: correcting the record, handing it over, unwinding it, closing it
 * out. The unwinding actions are here rather than behind the primary button
 * because they are the exception, but they have to exist somewhere: a lifecycle
 * you can only move forward through is one that eventually lies.
 */
export function DealActionsMenu({
  deal,
  teamMembers,
  communities,
  isLost,
  isClosed,
  isDeletable,
  reservation,
  agreement,
}: DealActionsMenuProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [editOpen, setEditOpen] = useState(false)
  const [lostOpen, setLostOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [voidOpen, setVoidOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  const reopen = () => {
    startTransition(async () => {
      try {
        unwrapAction(await reopenDealAction(deal.prospectId))
        toast({ title: "Deal reopened" })
        router.refresh()
      } catch (error) {
        toast({ title: "Could not reopen the deal", description: (error as Error).message })
      }
    })
  }

  const remove = () => {
    startTransition(async () => {
      try {
        unwrapAction(await deleteDealAction(deal.prospectId))
        toast({ title: "Deal deleted" })
        router.push("/sales")
      } catch (error) {
        toast({ title: "Could not delete the deal", description: (error as Error).message })
      }
    })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" className="size-8 rounded-none" aria-label="Deal actions" disabled={pending}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52 rounded-none">
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>Edit deal</DropdownMenuItem>

          {isLost ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={reopen}>Reopen deal</DropdownMenuItem>
            </>
          ) : isClosed ? null : (
            <>
              <DropdownMenuSeparator />
              {agreement ? (
                <DropdownMenuItem variant="destructive" onSelect={() => setVoidOpen(true)}>
                  Void the agreement
                </DropdownMenuItem>
              ) : null}
              {reservation ? (
                <DropdownMenuItem variant="destructive" onSelect={() => setReleaseOpen(true)}>
                  Release the lot
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem variant="destructive" onSelect={() => setLostOpen(true)}>
                Mark lost
              </DropdownMenuItem>
            </>
          )}

          {isDeletable ? (
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
              Delete deal
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <EditDealSheet
        deal={deal}
        teamMembers={teamMembers}
        communities={communities}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <MarkLostDialog prospectId={deal.prospectId} open={lostOpen} onOpenChange={setLostOpen} />

      {reservation ? (
        <ReleaseReservationDialog
          target={{
            reservationId: reservation.id,
            lotLabel: reservation.lotLabel,
            hasDeposit: reservation.hasDeposit,
          }}
          open={releaseOpen}
          onOpenChange={setReleaseOpen}
        />
      ) : null}

      {agreement ? (
        <VoidAgreementDialog
          contractId={agreement.contractId}
          hasDeposit={agreement.hasDeposit}
          open={voidOpen}
          onOpenChange={setVoidOpen}
        />
      ) : null}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent className="rounded-none">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deal.fullName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the lead and everything logged against it. For a buyer who was real but did not buy, mark
              the deal lost instead — that keeps them in the cancellation report.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-none">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={remove}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
