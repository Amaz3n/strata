"use client"

import { Landmark, ShieldCheck } from "lucide-react"

import { CompanyComplianceTab } from "@/components/companies/company-compliance-tab"
import { CompanyForm } from "@/components/companies/company-form"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { VendorPayableProfile } from "@/lib/services/companies"
import type { Company } from "@/lib/types"
import { cn } from "@/lib/utils"

import { VendorPaymentInviteButton } from "./vendor-payment-invite"

const PAYMENT_STATUS: Record<
  VendorPayableProfile["paymentReadiness"],
  { label: string; className: string; detail: string }
> = {
  ready: {
    label: "Ready for Arc Pay",
    className: "border-success/35 bg-success/10 text-success",
    detail: "This vendor has a verified payout destination and can receive bank transfers through Arc.",
  },
  verifying: {
    label: "Setup in progress",
    className: "border-warning/35 bg-warning/10 text-warning",
    detail: "The vendor started setup. Their payment provider still needs information or verification.",
  },
  invited: {
    label: "Invitation sent",
    className: "border-warning/35 bg-warning/10 text-warning",
    detail: "The vendor has an Arc Pay invitation but has not completed setup.",
  },
  not_started: {
    label: "Not set up for Arc Pay",
    className: "border-border bg-muted text-muted-foreground",
    detail: "Invite the vendor to verify their business and payout account in the secure vendor portal.",
  },
  suspended: {
    label: "Arc Pay suspended",
    className: "border-warning/35 bg-warning/10 text-warning",
    detail: "Payments are paused. A payments administrator must restore the relationship before it can be used.",
  },
  revoked: {
    label: "Arc Pay revoked",
    className: "border-destructive/35 bg-destructive/10 text-destructive",
    detail: "The payment relationship was withdrawn and cannot be re-invited until it is restored.",
  },
}

function ProfileValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b py-3 last:border-b-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  )
}

/**
 * Vendor work belongs together: directory identity, compliance, tax standing,
 * and Arc Pay readiness. Payout-bank edits deliberately do not appear here —
 * the vendor owns those details in their authenticated provider flow.
 */
export function PayableVendorProfileDialog({
  open,
  onOpenChange,
  company,
  initialName,
  profile,
  onSaved,
  onPaymentInvited,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  company?: Company
  initialName?: string
  profile: VendorPayableProfile | null
  onSaved: (company: Company) => void
  onPaymentInvited: () => void
}) {
  const status = profile ? PAYMENT_STATUS[profile.paymentReadiness] : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(88vh,54rem)] w-[min(96vw,72rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>{company ? company.name : `Add ${initialName || "vendor"}`}</DialogTitle>
          <DialogDescription>
            {company
              ? "Manage the vendor record that controls billing, compliance, tax, and payment readiness."
              : "Create the vendor once, then finish compliance and Arc Pay setup from the same profile."}
          </DialogDescription>
        </DialogHeader>

        {company ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <section className="grid gap-5 border-b px-6 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(19rem,0.7fr)] lg:px-8">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Landmark className="size-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">Arc Pay</h3>
                  {status ? <Badge variant="outline" className={cn("font-medium", status.className)}>{status.label}</Badge> : null}
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{status?.detail ?? "Payment readiness is loading."}</p>
                {profile && !["ready", "suspended", "revoked"].includes(profile.paymentReadiness) ? (
                  <div className="mt-4 flex items-center justify-between gap-4 border bg-muted/20 px-4 py-3">
                    <p className="text-xs leading-5 text-muted-foreground">Send a secure setup link. Arc never exposes the vendor’s full bank details.</p>
                    <VendorPaymentInviteButton companyId={company.id} readiness={profile.paymentReadiness} onInvited={onPaymentInvited} />
                  </div>
                ) : null}
              </div>
              <div className="border px-4">
                <ProfileValue label="Send payment to" value={profile?.payoutBankLast4 ? `${profile.payoutBankName ?? "Verified bank"} ending in ${profile.payoutBankLast4}` : "No verified payout account"} />
                <ProfileValue label="Last invitation" value={profile?.paymentInvitedAt ? profile.paymentInvitedAt.slice(0, 10) : "Not invited"} />
              </div>
            </section>

            <section className="border-b px-6 py-6 lg:px-8">
              <CompanyForm company={company} payablesMode onCancel={() => onOpenChange(false)} onSubmitted={onSaved} />
            </section>

            <section className="px-6 py-6 lg:px-8">
              <div className="mb-4 flex items-center gap-2">
                <ShieldCheck className="size-4 text-muted-foreground" />
                <div>
                  <h3 className="text-sm font-semibold">Compliance</h3>
                  <p className="text-xs text-muted-foreground">Requirements and documents that control approval and payment holds.</p>
                </div>
              </div>
              <CompanyComplianceTab company={company} />
            </section>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 lg:px-8">
            <CompanyForm
              initialName={initialName}
              payablesMode
              onCancel={() => onOpenChange(false)}
              onSubmitted={onSaved}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
