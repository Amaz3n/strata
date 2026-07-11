import { renderQuotePdf, type QuoteLine, type QuotePricingDisplay, type QuoteSigner } from "@/lib/pdfs/quote-document"
import type { ChangeOrder, ChangeOrderLine } from "@/lib/types"

type ChangeOrderPdfData = {
  orgName?: string | null
  orgLogoUrl?: string | null
  projectName?: string | null
  recipientName?: string | null
  recipientEmail?: string | null
  signerRole?: string | null
  changeOrder: ChangeOrder
}

function lineToQuoteLine(line: ChangeOrderLine, index: number): QuoteLine {
  const quantity = line.quantity ?? 1
  const baseTotal = Math.round(quantity * (line.unit_cost_cents ?? 0) + (line.allowance_cents ?? 0))
  const normalizedUnitCost = quantity > 0 ? Math.round(baseTotal / quantity) : baseTotal
  const notes = line.allowance_cents
    ? `Includes ${((line.allowance_cents ?? 0) / 100).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      })} allowance.`
    : undefined

  return {
    id: line.id ?? `co-line-${index}`,
    description: line.description,
    quantity,
    unit: line.unit ?? "unit",
    unit_cost_cents: normalizedUnitCost,
    metadata: notes ? { notes } : null,
  }
}

export async function renderChangeOrderPdf(data: ChangeOrderPdfData): Promise<Buffer> {
  const changeOrder = data.changeOrder
  const metadata = changeOrder.metadata ?? {}
  const signatureData = (metadata.signature_data as Record<string, any> | undefined)?.client ?? null
  const isApproved = changeOrder.status === "approved" || Boolean(changeOrder.approved_at)
  const signers: QuoteSigner[] | undefined = isApproved
    ? [
        {
          role: data.signerRole ?? "Client",
          name: signatureData?.signer_name ?? metadata.approved_signer_name ?? null,
          signedAt: signatureData?.signed_at ?? changeOrder.approved_at ?? null,
          signatureImage: signatureData?.signature_image ?? null,
        },
      ]
    : undefined
  const pricingDisplay = metadata.display?.pricing as QuotePricingDisplay | undefined

  return renderQuotePdf({
    variant: signers?.length ? "proposal" : "estimate",
    orgName: data.orgName ?? "Arc",
    orgLogoUrl: data.orgLogoUrl ?? null,
    orgAddress: null,
    documentLabel: signers?.length ? "Executed Change Order" : "Change Order",
    title: changeOrder.title,
    number: changeOrder.co_number != null ? String(changeOrder.co_number) : null,
    recipientName: data.recipientName ?? null,
    recipientEmail: data.recipientEmail ?? null,
    projectName: data.projectName ?? null,
    issuedAt: changeOrder.created_at ?? null,
    intro: typeof metadata.intro === "string" ? metadata.intro : null,
    summary: changeOrder.summary ?? changeOrder.description ?? null,
    terms: typeof metadata.terms === "string" ? metadata.terms : null,
    pricingDisplay: pricingDisplay ?? "itemized",
    subtotalCents: changeOrder.totals?.subtotal_cents ?? changeOrder.total_cents ?? null,
    taxCents: changeOrder.totals?.tax_cents ?? null,
    totalCents: changeOrder.total_cents ?? changeOrder.totals?.total_cents ?? null,
    validUntil: null,
    signers,
    lines: (changeOrder.lines ?? []).map(lineToQuoteLine),
  })
}
