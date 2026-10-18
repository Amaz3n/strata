import { renderQuotePdf } from "@/lib/pdfs/quote-document"

export interface SelectionApprovalPdfLine {
  selectionId: string
  categoryName: string
  optionName: string | null
  packageName: string | null
  priceCents: number
}

export interface SelectionApprovalPdfData {
  orgName: string | null
  orgLogoUrl: string | null
  orgAddress: string | null
  homeName: string | null
  buyerName: string | null
  buyerEmail: string | null
  groupName: string
  sentAt: string
  expiresAt: string | null
  termsHash: string
  totalCents: number
  lines: SelectionApprovalPdfLine[]
}

/**
 * The document a buyer signs to approve a group's selections. It is rendered
 * from the approval's frozen lines -- never from the live selections -- and
 * carries the terms hash, so the signed page and the confirmed selections are
 * provably the same terms.
 */
export function renderSelectionApprovalPdf(data: SelectionApprovalPdfData): Promise<Buffer> {
  return renderQuotePdf({
    variant: "proposal",
    orgName: data.orgName ?? "Builder",
    orgLogoUrl: data.orgLogoUrl,
    orgAddress: data.orgAddress,
    documentLabel: "Selections approval",
    title: `${data.groupName} selections`,
    number: data.termsHash.slice(0, 12).toUpperCase(),
    recipientName: data.buyerName,
    recipientEmail: data.buyerEmail,
    projectName: data.homeName,
    issuedAt: data.sentAt,
    intro: "By signing, you approve each selection below at the price shown. Once approved, a change is made by change order.",
    terms: `These are the selections and prices as they stood when this document was sent (terms ${data.termsHash}). If they change before you sign, this document is withdrawn and a new one is sent.`,
    pricingDisplay: "itemized",
    subtotalCents: data.totalCents,
    totalCents: data.totalCents,
    validUntil: data.expiresAt,
    signers: [{ role: "Buyer", name: data.buyerName }],
    lines: data.lines.map((line) => ({
      id: line.selectionId,
      description: `${line.categoryName}: ${line.optionName ?? "Not chosen"}${line.packageName ? ` (${line.packageName})` : ""}`,
      quantity: 1,
      unit: "ea",
      unit_cost_cents: line.priceCents,
    })),
  })
}
