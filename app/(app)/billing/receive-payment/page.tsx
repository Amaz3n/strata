import { z } from "zod"

import { ReceivePaymentWorkspace } from "@/components/payments/receive-payment-workspace"
import { PageLayout } from "@/components/layout/page-layout"
import { getReceivePaymentWorkspace } from "@/lib/services/payments"

export default async function ReceivePaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ partyType?: string; partyId?: string }>
}) {
  const params = await searchParams
  const parsed = z
    .object({
      partyType: z.enum(["contact", "company"]).optional(),
      partyId: z.string().uuid().optional(),
    })
    .safeParse(params)
  const filter = parsed.success && Boolean(parsed.data.partyType) === Boolean(parsed.data.partyId)
    ? parsed.data
    : {}
  const workspace = await getReceivePaymentWorkspace(filter)

  return (
    <PageLayout
      title="Receive payment"
      breadcrumbs={[{ label: "Billing", href: "/billing" }, { label: "Receive payment" }]}
      fullBleed
    >
      <ReceivePaymentWorkspace workspace={workspace} />
    </PageLayout>
  )
}
