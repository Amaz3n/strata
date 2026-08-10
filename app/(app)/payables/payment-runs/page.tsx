import { redirect } from "next/navigation"

/**
 * Payment runs no longer have a desk.
 *
 * A run is the envelope an approver signs for — real, but real for about ninety
 * seconds, to one person. Everyone else relates to it through a bill: the clerk
 * pays bills, the approver releases them, and the vendor is owed on one. Giving
 * it its own surface meant a second bill-selection table beside the payables
 * desk, and an approval queue nobody visited because approvals arrive by email.
 *
 * Composition and release now happen on the payables desk. Reconciliation moved
 * to Ops, where a daily job whose silence is the alarm belongs. This redirect
 * stays because approval emails already in inboxes point here.
 */
export default async function PaymentRunsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>
}) {
  const { run } = await searchParams
  redirect(run ? `/payables?run=${run}` : "/payables")
}
