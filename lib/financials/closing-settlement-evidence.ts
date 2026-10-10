import { z } from "zod"
import { buildPurchaseAgreementSettlement, buildClosingInvoiceLines, closingInvoiceLinesTotalCents } from "@/lib/financials/purchase-agreement-pricing"

// Evidence is verified, never rewritten: every object keeps the keys it was
// recorded with. The settlement and its closing invoice are compared by digest,
// and a real agreement's quote carries far more than the priced fields (choice
// prices, configuration, the quote hash), so stripping unknown keys here made
// every real closing fail to reconcile with its own invoice.
const cents = z.number().int().safe()
const pricedItem = z.object({ optionId: z.string().optional(), packageId: z.string().optional(), category: z.string().nullable().optional(), label: z.string(), priceCents: cents, source: z.string() }).passthrough()
const pricing = z.object({ basePriceCents: cents, lotPremiumCents: cents, structuralOptions: z.array(pricedItem), designSelections: z.array(pricedItem),
  incentives: z.array(z.object({ incentiveId: z.string(), name: z.string(), incentiveType: z.enum(["fixed_amount", "percent_of_base"]), appliesTo: z.enum(["price", "design_credit"]), amountCents: cents.nullable().optional(), percent: z.number().finite().nullable().optional(), valueCents: cents }).passthrough()),
  structuralOptionsCents: cents, designSelectionsCents: cents, incentivesCents: cents, totalCents: cents }).passthrough()
const schema = z.object({ builtAt: z.string().datetime(), contractId: z.string().uuid(), agreementEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  agreement: z.object({ id: z.string().uuid(), number: z.string().nullable(), signed_at: z.string().nullable() }).passthrough(), pricing,
  changeOrders: z.array(z.object({ id: z.string().uuid(), title: z.string().nullable().optional(), total_cents: cents, metadata: z.record(z.string(), z.unknown()).nullable().optional() }).passthrough()),
  components: z.object({ agreementTotalCents: cents, approvedChangeOrdersCents: cents, changeOrderIds: z.array(z.string().uuid()), adjustmentsCents: cents }).passthrough(),
  adjustments: z.array(z.object({ id: z.string(), label: z.string(), kind: z.enum(["seller_credit", "closing_cost", "proration", "other"]), amountCents: cents }).passthrough()),
  depositsApplied: z.array(z.object({ invoiceId: z.string().uuid(), paymentId: z.string().uuid(), label: z.string(), amountCents: cents.nonnegative(), receivedAt: z.string().nullable().optional() }).passthrough()),
  finalPriceCents: cents, depositsAppliedCents: cents.nonnegative(), balanceDueCents: cents.nonnegative() }).passthrough()

/** Closed homes must never reconstruct economic history from today's source rows. */
export function readClosedSettlementEvidence(value: unknown) {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error("Recorded closing settlement evidence is missing or invalid; reconcile the original closing records")
  const saved = parsed.data
  const calculated = buildPurchaseAgreementSettlement({ agreementTotalCents: saved.components.agreementTotalCents,
    approvedChangeOrders: saved.changeOrders.map(row => ({ id: row.id, totalCents: row.total_cents })),
    adjustments: saved.adjustments, deposits: saved.depositsApplied, builtAt: saved.builtAt })
  const amounts = [calculated.finalPriceCents, calculated.depositsAppliedCents, calculated.balanceDueCents, calculated.components.approvedChangeOrdersCents, calculated.components.adjustmentsCents]
  if (amounts.some(value => !Number.isSafeInteger(value)) || saved.agreement.id !== saved.contractId || saved.pricing.totalCents !== saved.components.agreementTotalCents ||
      calculated.finalPriceCents !== saved.finalPriceCents || calculated.depositsAppliedCents !== saved.depositsAppliedCents || calculated.balanceDueCents !== saved.balanceDueCents ||
      calculated.components.approvedChangeOrdersCents !== saved.components.approvedChangeOrdersCents || calculated.components.adjustmentsCents !== saved.components.adjustmentsCents ||
      JSON.stringify(calculated.components.changeOrderIds) !== JSON.stringify(saved.components.changeOrderIds) ||
      new Set(saved.depositsApplied.map(row => row.paymentId)).size !== saved.depositsApplied.length || new Set(saved.changeOrders.map(row => row.id)).size !== saved.changeOrders.length) {
    throw new Error("Recorded closing settlement does not reconcile; review the original closing records")
  }
  const lines = buildClosingInvoiceLines({ pricing: saved.pricing, lotLabel: "Home", planLabel: "Home",
    approvedChangeOrders: saved.changeOrders.map(row => ({ id: row.id, title: row.title ?? "Change order", totalCents: row.total_cents })), adjustments: saved.adjustments })
  if (closingInvoiceLinesTotalCents(lines) !== saved.finalPriceCents) throw new Error("Recorded closing invoice pricing does not reconcile")
  return saved
}
