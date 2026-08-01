import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { isVendorPayoutSetupOpen } from "@/lib/services/payment-rail-setup"
import { validatePortalToken } from "@/lib/services/portal-access"
import { getVendorPaymentSetupContext } from "@/lib/services/vendor-payment-identities"
import { VendorPaymentSetup } from "./vendor-payment-setup"

export const revalidate = 0

export default async function VendorPaymentsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const access = await validatePortalToken(token)
  if (!access || access.portal_type !== "sub" || !access.company_id) notFound()
  if (!(await isVendorPayoutSetupOpen(access.org_id))) notFound()

  const context = await getVendorPaymentSetupContext(token)
  return (
    <>
      <PortalPageHeader
        title="Get paid through Arc"
        description={`Verify your business and payout bank once with Stripe. The same verified account works with every Arc builder you connect, including ${context.builder.orgName}.`}
      />
      <VendorPaymentSetup token={token} context={context} />
    </>
  )
}
