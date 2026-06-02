import { renderQuotePdf, type QuoteLine, type QuotePricingDisplay, type QuoteSigner } from "@/lib/pdfs/quote-document"

type EstimateLine = QuoteLine

type EstimatePdfData = {
  orgName?: string
  orgLogoUrl?: string | null
  orgAddress?: string | null
  accentColor?: string | null
  fontFamily?: string | null
  estimateTitle: string
  estimateNumber?: string
  recipientName?: string
  recipientEmail?: string | null
  projectName?: string | null
  issuedAt?: string | null
  intro?: string | null
  summary?: string | null
  terms?: string | null
  pricingDisplay?: QuotePricingDisplay | null
  /** Ids of optional add-ons the client accepted (included in the table + total). */
  acceptedOptionalIds?: string[] | null
  /** When true (signed/executed docs), optional add-ons not accepted are omitted. */
  hideUnacceptedOptionals?: boolean
  subtotalCents?: number | null
  taxCents?: number | null
  totalCents?: number | null
  validUntil?: string | null
  documentLabel?: string | null
  signers?: QuoteSigner[]
  lines: EstimateLine[]
}

/**
 * Back-compat wrapper around the shared quote renderer. Renders the estimate
 * (review) variant — no signature block.
 */
export async function renderEstimatePdf(data: EstimatePdfData): Promise<Buffer> {
  return renderQuotePdf({
    variant: data.signers?.length ? "proposal" : "estimate",
    orgName: data.orgName,
    orgLogoUrl: data.orgLogoUrl,
    orgAddress: data.orgAddress,
    accentColor: data.accentColor,
    fontFamily: data.fontFamily,
    documentLabel: data.documentLabel,
    title: data.estimateTitle,
    number: data.estimateNumber,
    recipientName: data.recipientName,
    recipientEmail: data.recipientEmail,
    projectName: data.projectName,
    issuedAt: data.issuedAt,
    intro: data.intro,
    summary: data.summary,
    terms: data.terms,
    pricingDisplay: data.pricingDisplay,
    acceptedOptionalIds: data.acceptedOptionalIds,
    hideUnacceptedOptionals: data.hideUnacceptedOptionals,
    subtotalCents: data.subtotalCents,
    taxCents: data.taxCents,
    totalCents: data.totalCents,
    validUntil: data.validUntil,
    signers: data.signers,
    lines: data.lines,
  })
}
