/**
 * The rendered invoice is cached as a file so the portal and the email can hand
 * out the same bytes, and it is linked to the invoice under this role. It is
 * the invoice, not something attached to it, so every attachments surface
 * leaves it out.
 */
export const INVOICE_PDF_LINK_ROLE = "invoice_pdf"

export function isInvoiceAttachment(link: { link_role?: string | null }) {
  return link.link_role !== INVOICE_PDF_LINK_ROLE
}

/**
 * The settlement statement rendered when a closing settles, linked to that
 * closing's invoice. Unlike the invoice PDF it is a document *about* the sale
 * rather than the invoice itself, so it stays visible as an attachment.
 */
export const SETTLEMENT_STATEMENT_LINK_ROLE = "settlement_statement"
