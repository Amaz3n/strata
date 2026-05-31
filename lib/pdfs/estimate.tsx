import { renderQuotePdf, type QuoteLine, type QuoteSigner } from "@/lib/pdfs/quote-document"

type EstimateLine = QuoteLine

type EstimatePdfData = {
  orgName?: string
  orgLogoUrl?: string | null
  orgAddress?: string | null
  estimateTitle: string
  estimateNumber?: string
  recipientName?: string
  recipientEmail?: string | null
  projectName?: string | null
  summary?: string | null
  terms?: string | null
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
    documentLabel: data.documentLabel,
    title: data.estimateTitle,
    number: data.estimateNumber,
    recipientName: data.recipientName,
    recipientEmail: data.recipientEmail,
    projectName: data.projectName,
    summary: data.summary,
    terms: data.terms,
    subtotalCents: data.subtotalCents,
    taxCents: data.taxCents,
    totalCents: data.totalCents,
    validUntil: data.validUntil,
    signers: data.signers,
    lines: data.lines,
  })
}
