import { renderQuotePdf, type QuoteLine, type QuoteSigner } from "@/lib/pdfs/quote-document"

type ProposalPdfData = {
  orgName?: string | null
  orgLogoUrl?: string | null
  orgAddress?: string | null
  proposalTitle: string
  proposalNumber?: string
  recipientName?: string
  recipientEmail?: string | null
  projectName?: string | null
  summary?: string | null
  terms?: string | null
  subtotalCents?: number | null
  taxCents?: number | null
  totalCents?: number | null
  validUntil?: string | null
  signers?: QuoteSigner[]
  lines: QuoteLine[]
}

/**
 * Renders the proposal (execution) variant — same layout as the approved
 * estimate, plus org-templated terms and a signature block. The builder places
 * real e-sign fields over the signature block in the signing wizard.
 */
export async function renderProposalPdf(data: ProposalPdfData): Promise<Buffer> {
  return renderQuotePdf({
    variant: "proposal",
    orgName: data.orgName,
    orgLogoUrl: data.orgLogoUrl,
    orgAddress: data.orgAddress,
    title: data.proposalTitle,
    number: data.proposalNumber,
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
