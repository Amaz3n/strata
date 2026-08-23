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

const WAIVER_COPY = {
  conditional: {
    title: "Conditional lien waiver",
    certify: "conditional lien waiver",
    blurb: "It takes effect once the payment it covers actually clears.",
  },
  final: {
    title: "Final lien waiver",
    certify: "final lien waiver",
    blurb: "This covers the whole of your work on this job, including retainage.",
  },
  unconditional: {
    title: "Unconditional lien waiver",
    certify: "unconditional lien waiver",
    blurb: "This takes effect immediately, whether or not the payment has cleared.",
  },
} as const

export default async function VendorBillWaiverPortalPage({ params }: PageProps) {
  const { token, billId } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireProject: true,
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

  // Retainage is released against a FINAL waiver, so a payable that holds any
  // is asking for a different document from the progress waiver. Offering only
  // the conditional one is what made retainage unreleasable from this side.
  const hasRetainage = context.bill.retainage_cents > 0
  const signedTypes = new Set(
    context.waivers.filter((waiver) => waiver.status === "signed").map((waiver) => waiver.waiver_type),
  )
  const outstanding = (hasRetainage ? (["conditional", "final"] as const) : (["conditional"] as const)).filter(
    (type) => !signedTypes.has(type),
  )
  const activeType = outstanding[0] ?? "conditional"
  const copy = WAIVER_COPY[activeType]
  const allSigned = outstanding.length === 0

  return (
    <>
      <PortalPageHeader
        title={allSigned ? "Lien waivers" : copy.title}
        description={
          allSigned
            ? "Everything this payable needs from you has been signed."
            : `Sign this so the builder can release payment on ${
                context.bill.bill_number ? `invoice ${context.bill.bill_number}` : "this invoice"
              }.`
        }
      />

      <div className="space-y-5 border border-border bg-card p-4 sm:p-6">
        <div className="grid gap-3 border border-border p-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Claimant</p>
            <p className="font-medium">{context.company.name}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Amount</p>
            <p className="font-medium tabular-nums">
              {formatMoneyCentsExact(context.bill.total_cents)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Commitment</p>
            <p className="font-medium">{context.commitment?.title ?? "Not linked"}</p>
          </div>
          {hasRetainage ? (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Retainage held</p>
              <p className="font-medium tabular-nums">
                {formatMoneyCentsExact(context.bill.retainage_cents)}
              </p>
            </div>
          ) : (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Status</p>
              <p className="font-medium">{allSigned ? "Signed" : "Awaiting signature"}</p>
            </div>
          )}
        </div>

        {context.waivers.some((waiver) => waiver.status === "signed") ? (
          <ul className="divide-y border border-border text-sm">
            {context.waivers
              .filter((waiver) => waiver.status === "signed")
              .map((waiver) => (
              <li key={waiver.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="capitalize">{waiver.waiver_type} waiver</span>
                <span className="text-xs text-muted-foreground">
                  Signed{waiver.signer_name ? ` by ${waiver.signer_name}` : ""}
                </span>
                </li>
              ))}
          </ul>
        ) : null}

        {allSigned ? (
          <div className="border border-border bg-muted/40 p-4 text-sm">
            This payable is eligible for release once every other payment gate is clear.
          </div>
        ) : (
          <form
            action={signVendorBillWaiverPortalAction.bind(null, token, billId)}
            className="space-y-4"
          >
            <input type="hidden" name="waiver_type" value={activeType} />
            <p className="text-sm text-muted-foreground">{copy.blurb}</p>
            <div className="space-y-2">
              <Label htmlFor="signer_name">Signer name</Label>
              <Input id="signer_name" name="signer_name" required placeholder="Full legal name" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signature_text">Typed signature</Label>
              <Input
                id="signature_text"
                name="signature_text"
                required
                placeholder="Type your signature"
              />
            </div>
            <label className="flex items-start gap-2 border border-border p-3 text-sm">
              <input name="consent_accepted" type="checkbox" required className="mt-1" />
              <span>
                I certify that I am authorized to sign this {copy.certify} for{" "}
                {context.company.name}.
              </span>
            </label>
            <Button type="submit" className="w-full">
              Sign {activeType} waiver
            </Button>
          </form>
        )}
      </div>
    </>
  )
}
