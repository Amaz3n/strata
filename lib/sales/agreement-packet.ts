import { z } from "zod"

import { homePriceAdjustments, type PurchaseAgreementPricing } from "@/lib/financials/purchase-agreement-pricing"
import type { AgreementContingencyTerm } from "@/lib/validation/community-sales"

/**
 * The purchase agreement packet: the org's own agreement and addenda, pinned by
 * version and content hash, plus the Schedule A Arc fills in. Arc supplies no
 * legal text. Which documents apply is decided only by the database resolver
 * (`resolve_agreement_packet`), which also owns the hash; this module reads
 * what it returns and lays out what Arc prints.
 */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

export const agreementPacketDocumentSchema = z.object({
  kind: z.enum(["agreement", "addendum"]),
  template_id: z.string().uuid(),
  version_id: z.string().uuid(),
  version_number: z.number().int().min(1),
  title: z.string().min(1),
  required: z.boolean(),
  content_sha256: sha256,
  page_count: z.number().int().min(1),
})

export const agreementPacketSchema = z.object({
  jurisdiction: z.string().nullable(),
  community_id: z.string().uuid(),
  documents: z.array(agreementPacketDocumentSchema).min(1),
  hash: sha256,
})

export const resolvedAgreementPacketSchema = agreementPacketSchema.extend({
  optional_offered: z.array(z.object({ template_id: z.string().uuid(), version_id: z.string().uuid(), title: z.string() })),
})

export type AgreementPacketDocument = z.infer<typeof agreementPacketDocumentSchema>
export type AgreementPacket = z.infer<typeof agreementPacketSchema>
export type ResolvedAgreementPacket = z.infer<typeof resolvedAgreementPacketSchema>

/** The packet stored on an agreement is the resolution without the offer list. */
export function storedAgreementPacket(resolved: ResolvedAgreementPacket): AgreementPacket {
  const { optional_offered: _offered, ...packet } = resolved
  return packet
}

export const AGREEMENT_PACKET_REFUSALS = [
  "AGREEMENT_PACKET_UNAVAILABLE",
  "AGREEMENT_PACKET_AMBIGUOUS",
  "AGREEMENT_PACKET_CHANGED",
  "AGREEMENT_PACKET_STALE",
] as const
export type AgreementPacketRefusal = (typeof AGREEMENT_PACKET_REFUSALS)[number]

/** A refusal the database raised about the packet, carried to the form by its code. */
export class AgreementPacketError extends Error {
  readonly code: AgreementPacketRefusal
  constructor(code: AgreementPacketRefusal, message: string) {
    super(message)
    this.code = code
  }
}

/** The packet refusal a database error carries in its detail, or null when it is some other failure. */
export function agreementPacketRefusal(error: { message: string; details?: string | null } | null): AgreementPacketError | null {
  const code = AGREEMENT_PACKET_REFUSALS.find((refusal) => refusal === error?.details)
  return error && code ? new AgreementPacketError(code, error.message) : null
}

export type ScheduleAParty = { name: string; email: string | null }

export type ScheduleA = {
  agreementNumber: string
  effectiveDate: string | null
  buyers: ScheduleAParty[]
  property: Array<{ label: string; value: string }>
  priceLines: Array<{ label: string; amountCents: number }>
  totalCents: number
  stipulations: string | null
  /** How the buyer pays and what the sale is contingent on, in signing order. */
  conditions: Array<{ label: string; value: string }>
}

/**
 * Schedule A: the buyer-specific data Arc prints ahead of the org's documents.
 * Every price line comes from the agreement's pricing snapshot, so it sums to
 * the agreement total by construction.
 */
export function buildScheduleA(input: {
  agreementNumber: string
  effectiveDate: string | null
  buyer: ScheduleAParty
  coBuyer: ScheduleAParty | null
  community: string | null
  lot: string | null
  address: string | null
  plan: string | null
  elevation: string | null
  swing: string | null
  pricing: PurchaseAgreementPricing
  stipulations: string | null
  financing: "cash" | "financed"
  contingencies: AgreementContingencyTerm[]
}): ScheduleA {
  const { pricing } = input
  const priceLines = [
    { label: "Community base price", amountCents: pricing.basePriceCents },
    ...(pricing.lotPremiumCents ? [{ label: "Lot premium", amountCents: pricing.lotPremiumCents }] : []),
    ...pricing.structuralOptions.map((item) => ({ label: item.label, amountCents: item.priceCents })),
    ...pricing.designSelections.map((item) => ({ label: item.label, amountCents: item.priceCents })),
    ...pricing.incentives.map((item) => ({ label: `Incentive: ${item.name}`, amountCents: -item.valueCents })),
    ...homePriceAdjustments(pricing).map((item) => ({ label: item.label, amountCents: item.amountCents })),
  ]
  const property = [
    ["Community", input.community],
    ["Lot", input.lot],
    ["Address", input.address],
    ["Plan", input.plan],
    ["Elevation", input.elevation],
    ["Garage swing", input.swing ? `${input.swing[0].toUpperCase()}${input.swing.slice(1)}` : null],
  ].flatMap(([label, value]) => (value ? [{ label: label as string, value }] : []))
  const linesTotal = priceLines.reduce((sum, line) => sum + line.amountCents, 0)
  if (linesTotal !== pricing.totalCents) {
    throw new Error(`Schedule A lines total ${linesTotal} but the agreement price is ${pricing.totalCents}. Reconcile the pricing snapshot before preparing signatures.`)
  }
  return {
    agreementNumber: input.agreementNumber,
    effectiveDate: input.effectiveDate,
    buyers: [input.buyer, ...(input.coBuyer ? [input.coBuyer] : [])],
    property,
    priceLines,
    totalCents: pricing.totalCents,
    stipulations: input.stipulations?.trim() ? input.stipulations.trim() : null,
    conditions: [
      { label: "Financing", value: input.financing === "cash" ? "Cash purchase" : "Financed purchase" },
      ...input.contingencies.map((term) => ({ label: term.title, value: describeContingencyTerm(term) })),
    ],
  }
}

/** One contingency on Schedule A: its deadline, what it holds, and what proves it. */
function describeContingencyTerm(term: AgreementContingencyTerm): string {
  const deadline = term.due_on
    ? `Due ${term.due_on}`
    : term.due_in_days !== undefined ? `Due ${term.due_in_days} day${term.due_in_days === 1 ? "" : "s"} after signing` : "No deadline"
  const holds = term.required_before === "start" ? "holds the start" : "holds closing"
  return `${deadline} · ${holds}${term.evidence_required ? " · written evidence required" : ""}`
}

/** What a seller is told when the packet stops a sale, by refusal. */
export function describeAgreementPacketRefusal(code: AgreementPacketRefusal): string {
  switch (code) {
    case "AGREEMENT_PACKET_UNAVAILABLE":
      return "No published purchase agreement covers this home. Publish one under Settings → Templates → Agreements."
    case "AGREEMENT_PACKET_AMBIGUOUS":
      return "Two published purchase agreements apply equally to this home. Narrow or retire one under Settings → Templates → Agreements."
    case "AGREEMENT_PACKET_CHANGED":
      return "The agreement documents changed while you were writing it. Review the refreshed packet."
    case "AGREEMENT_PACKET_STALE":
      return "A document in this agreement's packet was withdrawn or a new required addendum was published. Refresh the packet before signing."
  }
}
