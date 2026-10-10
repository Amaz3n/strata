import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { OrgServiceContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { prepareProjectCreation, prepareProjectOpeningContract, prepareProjectAccountingDimensions } from "@/lib/services/projects"
import { prepareProjectFinancialSettings } from "@/lib/services/project-financial-setup"
import { prepareInvoiceAmounts, prepareInvoiceCreation } from "@/lib/services/invoices"
import type { InvoiceInput } from "@/lib/validation/invoices"
import { reservationConversionExpectedSchema, reservationConversionStateSchema, reservationConversionScopeSchema, savedReservationConversionInputSchema, type ReservationConversionExpected, type ReservationConversionScope, type ReservationConversionState } from "@/lib/validation/reservation-conversion"

export function reservationConversionEnabled() {
  return process.env.ARC_RESERVATION_CONVERSION_ENABLED === "true"
}

/** Reuses the original financial owners; no writes or provider calls occur here. */
export function prepareReservationConversionBundle({ context, requestKey, input, expected: source, now = new Date().toISOString() }: {
  context: Pick<OrgServiceContext, "orgId" | "userId" | "productTier">
  requestKey: string
  input: z.infer<typeof savedReservationConversionInputSchema>
  expected: ReservationConversionExpected
  now?: string
}) {
  z.string().uuid().parse(requestKey)
  const expected = reservationConversionExpectedSchema.parse(source)
  const savedInput = savedReservationConversionInputSchema.parse(input)
  if (expected.reservation.id !== savedInput.reservationId || expected.reservation.org_id !== context.orgId || expected.lot.id !== expected.reservation.lot_id || expected.lot.org_id !== context.orgId || expected.lot.community_id !== expected.community.id || expected.community.id !== expected.reservation.community_id || expected.lot.project_id !== (expected.home?.id ?? null) || (expected.home && expected.home.division_id !== expected.community.division_id)) throw new Error("The original reservation hierarchy changed")
  const buyer = expected.buyers.find(row => row.id === expected.reservation.buyer_contact_id)
  if (!buyer) throw new Error("The reviewed reservation buyer is unavailable")
  const projectId = expected.home?.id ?? randomUUID()
  const homeName = expected.home?.name ?? savedInput.projectName ?? `Lot ${expected.lot.lot_number}`
  const callerInput = { name: homeName, property_type: "production" as const, status: "planning" as const, client_id: buyer.id, prospect_id: expected.reservation.prospect_id }
  const project = expected.home ? null : prepareProjectCreation({ input: callerInput, orgId: context.orgId, userId: context.userId, productTier: context.productTier })
  const billingContract = project ? prepareProjectOpeningContract({ callerInput, input: project.input, productTier: context.productTier, orgId: context.orgId, projectId, projectName: homeName }) : null
  const settings = project ? prepareProjectFinancialSettings({ orgId: context.orgId, projectId, userId: context.userId, input: project.input, existingContract: billingContract, existingRawCostCodesEnabled: null, now }) : null
  const recipients = savedInput.depositCents > 0 && buyer.email ? [buyer.email] : []
  const invoiceInput: InvoiceInput = {
    project_id: projectId, invoice_number: `DEP-${requestKey}`, title: "Earnest deposit", issue: true,
    issue_date: now.slice(0, 10), due_date: now.slice(0, 10), tax_rate: 0, customer_id: buyer.id,
    customer_name: buyer.full_name, sent_to_emails: recipients,
    lines: [{ description: "Earnest deposit", quantity: 1, unit: "deposit", unit_cost: savedInput.depositCents / 100, taxable: false }],
    metadata: { invoice_kind: "earnest_deposit", source_reservation_id: savedInput.reservationId },
  }
  const invoice = savedInput.depositCents > 0 ? prepareInvoiceCreation({ input: invoiceInput, orgId: context.orgId, userId: context.userId, productPosture: "production", approvalStatus: "not_required", sourceContext: null, ...prepareInvoiceAmounts(invoiceInput, null), orgInfo: expected.organization, token: randomUUID(), now }) : null
  return {
    expected, projectId, project: project?.project ?? null, billingContract,
    financialSettings: settings, accountingDimensions: prepareProjectAccountingDimensions({ classId: null, customerId: null }), invoice,
    review: { buyerName: buyer.full_name, lotLabel: expected.lot.lot_number, communityName: expected.community.name, homeName, createsHome: expected.home === null, recipients, expiresAt: expected.reservation.expires_at },
  }
}

export function assertReservationConversionScope(scope: ReservationConversionScope, context: Pick<OrgServiceContext, "orgId" | "userId">) {
  if (scope.orgId !== context.orgId || scope.actorId !== context.userId) throw new Error("The reservation review belongs to another signed-in context. Return to its original buyer file.")
}

export async function callReservationConversion({ context, scope, action, requestKey = null, input = null, bundle = null }: {
  context: OrgServiceContext
  scope: ReservationConversionScope
  action: "inspect" | "register" | "commit" | "cancel"
  requestKey?: string | null
  input?: z.infer<typeof savedReservationConversionInputSchema> | null
  bundle?: ReturnType<typeof prepareReservationConversionBundle> | null
}): Promise<ReservationConversionState | null> {
  if (!reservationConversionEnabled()) throw new Error("Reservation review is not enabled")
  assertReservationConversionScope(scope, context)
  const { data, error } = await createServiceSupabaseClient().rpc("reservation_conversion", {
    p_org_id: context.orgId, p_actor_id: context.userId, p_reservation_id: scope.reservationId,
    p_action: action, p_request_key: requestKey, p_input: input, p_bundle: bundle,
  })
  if (error) throw new Error(`Reservation ${action} could not be confirmed. Inspect the saved review before retrying: ${error.message}`)
  const sameScope = (actual: ReservationConversionScope) => actual.orgId === scope.orgId && actual.actorId === scope.actorId && actual.reservationId === scope.reservationId
  if (action === "inspect") {
    const reply = z.object({ scope: reservationConversionScopeSchema, latest: reservationConversionStateSchema.nullable() }).strict().parse(data)
    if (!sameScope(reply.scope) || (reply.latest && !sameScope(reply.latest.scope))) throw new Error("Saved reservation response belongs to another context")
    return reply.latest
  }
  const state = reservationConversionStateSchema.parse(data)
  if (!sameScope(state.scope) || state.requestKey !== requestKey || (input && (state.input.reservationId !== input.reservationId || state.input.depositCents !== input.depositCents || state.input.projectName !== input.projectName))) throw new Error("Saved reservation response does not match the original request")
  if (action === "commit" && state.status !== "committed") throw new Error("Reservation commit has no verified receipt. Inspect the saved review before retrying.")
  if (action === "cancel" && state.status !== "cancelled" && state.status !== "committed") throw new Error("Reservation review cancellation could not be confirmed")
  return state
}
