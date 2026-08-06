import { notFound, redirect } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { isVendorPayoutSetupOpen, reconcileVendorRecipientAfterOnboarding } from "@/lib/services/payment-rail-setup"
import { validatePortalToken } from "@/lib/services/portal-access"
import { getVendorPaymentSetupContext } from "@/lib/services/vendor-payment-identities"
import { VendorPaymentSetup } from "./vendor-payment-setup"

export const revalidate = 0

export default async function VendorPaymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ payments?: string; entity?: string; verified?: string }>
}) {
  // `payments=refresh` is Stripe returning an expired onboarding link. It is not
  // an error the vendor caused and there is nothing to reconcile — the account
  // exists, the link simply timed out — so the page says that plainly and leaves
  // the same start button in place.
  const { token } = await params
  const query = await searchParams
  const access = await validatePortalToken(token)
  if (!access || access.portal_type !== "sub" || !access.company_id) notFound()
  if (!(await isVendorPayoutSetupOpen(access.org_id))) notFound()

  if (query.payments === "return" && query.entity) {
    await reconcileVendorRecipientAfterOnboarding(query.entity)
    // `verified` marks this one arrival back from Stripe, so the success check
    // plays for the vendor who just finished and not on every later visit.
    redirect(`/s/${token}/payments?verified=1`)
  }
  const context = await getVendorPaymentSetupContext(token)
  return (
    <>
      <PortalPageHeader
        title="Get paid through Arc"
        description={`Verify your business and payout bank once with Stripe. The same verified account works with every Arc builder you connect, including ${context.builder.orgName}.`}
      />
      <VendorPaymentSetup
        token={token}
        context={context}
        justVerified={query.verified === "1"}
        linkExpired={query.payments === "refresh"}
      />
    </>
  )
}
