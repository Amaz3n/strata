"use client"

import { useTransition } from "react"
import { toast } from "sonner"

import { inviteCompanyToPaymentSetupAction } from "@/app/(app)/companies/actions"
import { Button } from "@/components/ui/button"
import { unwrapAction } from "@/lib/action-result"
import type { CompanyPaymentReadinessStatus } from "@/lib/services/vendor-payment-invitations"

/**
 * The cure for the one obstacle the payables workspace can actually clear
 * itself: a vendor with no bank details on file, so the payable cannot leave by
 * ACH. It sits with the payment action because that is where the obstacle bites.
 */
export function VendorPaymentInviteButton({
  companyId,
  readiness,
  onInvited,
}: {
  companyId: string
  readiness?: CompanyPaymentReadinessStatus
  onInvited: () => void
}) {
  const [isInviting, startInviting] = useTransition()

  const invite = () =>
    startInviting(async () => {
      try {
        const result = unwrapAction(await inviteCompanyToPaymentSetupAction(companyId))
        toast.success(`Invitation sent to ${result.companyName}`)
        onInvited()
      } catch (error) {
        toast.error("Unable to send the invitation", { description: (error as Error).message })
      }
    })

  return (
    <Button variant="link" size="sm" className="h-auto p-0 text-xs" disabled={isInviting} onClick={invite}>
      {isInviting
        ? "Sending…"
        : readiness === "invited"
          ? "Remind them to finish setup"
          : "Invite to Arc Pay"}
    </Button>
  )
}
