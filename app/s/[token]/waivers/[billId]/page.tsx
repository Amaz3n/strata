import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { getVendorBillWaiverForPortal } from "@/lib/services/lien-waivers"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { formatMoneyCentsExact } from "@/lib/utils"

interface PageProps {
  params: Promise<{ token: string; billId: string }>
}

export default async function VendorBillWaiverPortalPage({
  params,
}: PageProps) {
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

  return (
    <>
      <PortalPageHeader
        title="Lien waivers"
        description="Review and sign the prepared PDF using your individual signing invitation."
      />
      <div className="space-y-4 border p-5 text-sm">
        <p>
          {context.company.name} · {context.bill.bill_number ?? "Payable"} ·{" "}
          {formatMoneyCentsExact(context.bill.total_cents)}
        </p>
        <p>
          The builder sends a signing link to the designated signer after
          preparing the waiver. If you have not received it, ask the builder to
          prepare or resend the invitation.
        </p>
        <p className="text-muted-foreground">
          A signature is followed by the builder’s coverage review. Payment
          eligibility also depends on the other payable requirements.
        </p>
        {context.waivers.map((w) => (
          <p key={w.id}>
            {w.waiver_type.replaceAll("_", " ")} ·{" "}
            {w.status === "signed"
              ? "Signed — coverage review required"
              : "Preparation or signature pending"}
          </p>
        ))}
      </div>
    </>
  )
}
