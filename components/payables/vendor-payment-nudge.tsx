"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { inviteCompanyToPaymentSetupAction } from "@/app/(app)/companies/actions"
import { ChevronDown, ChevronUp } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { unwrapAction } from "@/lib/action-result"
import type { UnpayableVendor } from "@/lib/services/vendor-payment-invitations"

function money(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

const STATUS_LABEL: Record<UnpayableVendor["status"], string> = {
  ready: "Ready",
  verifying: "Verifying",
  invited: "Invited",
  not_started: "Not invited",
}

/**
 * Vendors with money waiting who cannot be paid electronically yet. Shown only
 * when the org has set up vendor payments — otherwise there is nothing to invite
 * anyone to. Collapsed to a single line by default: the payables table is the
 * page, and this is a standing condition rather than today's work.
 */
export function VendorPaymentNudge({ vendors }: { vendors: UnpayableVendor[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [invitingId, setInvitingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  if (vendors.length === 0) return null

  const totalCents = vendors.reduce((sum, vendor) => sum + vendor.outstandingCents, 0)

  const invite = (vendor: UnpayableVendor) => {
    setInvitingId(vendor.companyId)
    startTransition(async () => {
      try {
        const result = unwrapAction(await inviteCompanyToPaymentSetupAction(vendor.companyId))
        toast.success(`Invitation sent to ${result.companyName}`, {
          description: `${result.recipients} ${result.recipients === 1 ? "contact" : "contacts"} notified.`,
        })
        router.refresh()
      } catch (error) {
        toast.error("Unable to send the invitation", {
          description: error instanceof Error ? error.message : undefined,
        })
      } finally {
        setInvitingId(null)
      }
    })
  }

  return (
    <section className="border-b px-4 sm:px-6">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? <ChevronUp className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
        <span className="microlabel">Still paid by check</span>
        <span className="truncate">
          <span className="tabular-nums">{money(totalCents)}</span> owed to {vendors.length}{" "}
          {vendors.length === 1 ? "vendor" : "vendors"} who cannot be paid electronically yet
        </span>
      </button>

      {!expanded ? null : (
      <div className="divide-y divide-border border-t border-border pb-3">
        {vendors.map((vendor) => (
          <div key={vendor.companyId} className="flex items-center justify-between gap-4 py-2.5">
            <div className="flex min-w-0 items-baseline gap-3">
              <Link
                href={`/companies/${vendor.companyId}`}
                className="truncate text-sm font-medium hover:underline"
              >
                {vendor.companyName}
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">
                {vendor.openBillCount} open · {STATUS_LABEL[vendor.status]}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-sm tabular-nums">{money(vendor.outstandingCents)}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => invite(vendor)}
              >
                {invitingId === vendor.companyId && pending
                  ? "Sending…"
                  : vendor.status === "not_started"
                    ? "Invite"
                    : "Remind"}
              </Button>
            </div>
          </div>
        ))}
      </div>
      )}
    </section>
  )
}
