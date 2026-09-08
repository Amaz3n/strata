import { notFound, redirect } from "next/navigation"

import { PortalAccountGate } from "@/components/portal/account/portal-account-gate"
import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { isVendorPayoutSetupOpen, reconcileVendorRecipientAfterOnboarding } from "@/lib/services/payment-rail-setup"
import {
  getExternalPortalGateContext,
  hasExternalPortalGrantForToken,
} from "@/lib/services/external-portal-auth"
import { validatePortalToken } from "@/lib/services/portal-access"
import { getVendorPaymentSetupContext, getVendorPortalPaymentAccess } from "@/lib/services/vendor-payment-identities"
import { VendorPaymentSetup } from "./vendor-payment-setup"

const CLOSED_COPY = {
  suspended: {
    title: "Electronic payment is paused",
    body: "This builder has paused electronic payment to your company. Nothing you already did is lost, and any payment they already released is still on its way. They can restore it from your vendor record — the fastest route is to call the person you normally invoice.",
  },
  revoked: {
    title: "Electronic payment was withdrawn",
    body: "This builder withdrew electronic payment to your company. They can still pay you by check, and any payment they already released is unaffected. If you think this is a mistake, contact the person you normally invoice.",
  },
  not_invited: {
    title: "This builder has not invited you yet",
    body: "Direct deposit starts with an invitation from the builder. Ask the person you normally invoice to invite your company to electronic payment, and this page will walk you through it. Until then they pay you the way they always have.",
  },
} as const

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

  // Read before anything else touches payout state. A suspended or revoked
  // relationship makes every other call on this page throw, and a vendor whose
  // access a builder withdrew deserves a sentence explaining it rather than the
  // portal's generic error card.
  const paymentAccess = await getVendorPortalPaymentAccess(token)
  if (paymentAccess.state !== "open") {
    const copy = CLOSED_COPY[paymentAccess.state === "withdrawn" ? paymentAccess.status : "not_invited"]
    return (
      <>
        <PortalPageHeader title="Get paid through Arc" description="Your electronic payment status with this builder." />
        <section className="border border-warning/40 bg-warning/5 p-6 desk-rise" role="status">
          <h2 className="text-base font-semibold text-warning">{copy.title}</h2>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">{copy.body}</p>
        </section>
      </>
    )
  }

  // The payout gate needs a signed-in identity holding a grant on THIS link, and
  // it throws when there is none. On a payout invitation the layout's account
  // wall catches that first (`require_account` is set at mint), but a link
  // issued before dedicated payout tokens has no such flag — and the vendor got
  // "Sign in and claim this vendor invitation" rendered into the portal's
  // generic error card, with no form anywhere on the page. Ask the same
  // question here and answer it with the account form.
  const hasGrant = await hasExternalPortalGrantForToken({
    orgId: access.org_id,
    tokenId: access.id,
    tokenType: "portal",
  })
  if (!hasGrant) {
    const gate = await getExternalPortalGateContext({ token, tokenType: "portal" })
    return (
      <>
        <PortalPageHeader
          title="Get paid through Arc"
          description="Create your Arc account to set up direct deposit. It takes a minute and your payout bank stays yours."
        />
        <PortalAccountGate
          token={token}
          tokenType="portal"
          layout="section"
          purpose="vendor_payout"
          orgName={gate?.orgName ?? "the builder"}
          projectName={gate?.projectName ?? "your company"}
          initialEmail={gate?.expectedEmail ?? ""}
          suggestedFullName={gate?.suggestedFullName ?? ""}
          emailLocked={gate?.emailLocked}
        />
      </>
    )
  }

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
