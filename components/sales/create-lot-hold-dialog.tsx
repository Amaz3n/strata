"use client"

import type { PipelineCommunityOption } from "@/components/prospects/prospect-presentation"
import { LotHoldForm, type HoldBuyer } from "@/components/sales/lot-hold-form"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface CreateLotHoldDialogProps {
  buyer: HoldBuyer | null
  communities: PipelineCommunityOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Lead → backlog baton pass, for surfaces that arrive without a lot already
 * chosen. Find a home holds through the same form without a second dialog.
 */
export function CreateLotHoldDialog({ buyer, communities, open, onOpenChange }: CreateLotHoldDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="overflow-hidden rounded-none p-0 sm:max-w-md">
        <DialogHeader className="space-y-1 px-5 pt-5 text-left">
          <DialogTitle className="text-base font-semibold">Hold a lot for {buyer?.name ?? "buyer"}</DialogTitle>
          <DialogDescription className="text-xs">
            Puts a soft hold on the lot. Holds expire on their own; convert to a reservation from the community&apos;s
            Sales tab to invoice the earnest deposit.
          </DialogDescription>
        </DialogHeader>
        {/* Remounted per open so the form never reopens holding stale dates. */}
        {open ? (
          <LotHoldForm
            buyer={buyer}
            communities={communities}
            onCancel={() => onOpenChange(false)}
            onHeld={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
