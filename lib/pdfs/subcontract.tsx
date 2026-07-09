import { renderQuotePdf, type QuoteLine, type QuoteSigner } from "@/lib/pdfs/quote-document"

type SubcontractPdfData = {
  orgName?: string | null
  orgLogoUrl?: string | null
  orgAddress?: string | null
  title: string
  contractNumber?: string | null
  companyName?: string | null
  companyEmail?: string | null
  projectName?: string | null
  scope?: string | null
  terms?: string | null
  retainagePercent?: number | null
  totalCents?: number | null
  signers?: QuoteSigner[]
  lines: QuoteLine[]
}

/**
 * Renders a subcontract/PO agreement from a commitment: parties, scope of
 * work, schedule of values, retainage, terms, and signature blocks. The
 * builder places real e-sign fields over the signature blocks in the signing
 * wizard before sending to the vendor.
 */
export async function renderSubcontractPdf(data: SubcontractPdfData): Promise<Buffer> {
  const termsParts: string[] = []
  if (data.retainagePercent != null && data.retainagePercent > 0) {
    termsParts.push(
      `Retainage: ${data.retainagePercent}% will be withheld from each payment and released upon final completion and acceptance of the work.`,
    )
  }
  if (data.terms?.trim()) {
    termsParts.push(data.terms.trim())
  }

  return renderQuotePdf({
    variant: "proposal",
    documentLabel: "Subcontract Agreement",
    orgName: data.orgName,
    orgLogoUrl: data.orgLogoUrl,
    orgAddress: data.orgAddress,
    title: data.title,
    number: data.contractNumber ?? undefined,
    recipientName: data.companyName ?? undefined,
    recipientEmail: data.companyEmail ?? null,
    projectName: data.projectName,
    summary: data.scope ?? null,
    terms: termsParts.length > 0 ? termsParts.join("\n\n") : null,
    subtotalCents: data.totalCents,
    totalCents: data.totalCents,
    signers: data.signers,
    lines: data.lines,
  })
}
