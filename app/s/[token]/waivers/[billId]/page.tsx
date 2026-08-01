import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getVendorBillWaiverForPortal } from "@/lib/services/lien-waivers"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { formatMoneyCentsExact } from "@/lib/utils"
import { signVendorBillWaiverPortalAction } from "./actions"

interface PageProps {
  params: Promise<{ token: string; billId: string }>
}

export const revalidate = 0

export default async function VendorBillWaiverPortalPage({ params }: PageProps) {
  const { token, billId } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_view_bills",
    })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()

  const context = await getVendorBillWaiverForPortal({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    billId,
  })
  if (!context) notFound()

  const alreadySigned = context.bill.lien_waiver_status === "received" || context.waiver?.status === "signed"

  return (
    <>
      <PortalPageHeader
        title="Conditional lien waiver"
        description={`Sign this waiver so the builder can release payment on ${
          context.bill.bill_number ? `invoice ${context.bill.bill_number}` : "this invoice"
        }.`}
      />

      <div className="space-y-5 border border-border bg-card p-4 sm:p-6">
        <div className="grid gap-3 border border-border p-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Claimant</p>
            <p className="font-medium">{context.company.name}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Amount</p>
            <p className="font-medium tabular-nums">{formatMoneyCentsExact(context.bill.total_cents)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Commitment</p>
            <p className="font-medium">{context.commitment?.title ?? "Not linked"}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
            <p className="font-medium capitalize">{alreadySigned ? "signed" : "awaiting signature"}</p>
          </div>
        </div>

        {alreadySigned ? (
          <div className="border border-border bg-muted/40 p-4 text-sm">
            This waiver has been signed and the invoice is eligible for payment release once all other payment gates are clear.
          </div>
        ) : (
          <form action={signVendorBillWaiverPortalAction.bind(null, token, billId)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="signer_name">Signer name</Label>
              <Input id="signer_name" name="signer_name" required placeholder="Full legal name" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signature_text">Typed signature</Label>
              <Input id="signature_text" name="signature_text" required placeholder="Type your signature" />
            </div>
            <label className="flex items-start gap-2 border border-border p-3 text-sm">
              <input name="consent_accepted" type="checkbox" required className="mt-1" />
              <span>
                I certify that I am authorized to sign this conditional lien waiver for {context.company.name}.
              </span>
            </label>
            <Button type="submit" className="w-full">
              Sign waiver
            </Button>
          </form>
        )}
      </div>
    </>
  )
}
