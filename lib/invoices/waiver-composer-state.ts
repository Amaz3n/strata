import type {
  ArcInvoiceDocumentData,
  ArcInvoiceLine,
} from "@/components/invoices/arc-invoice-document";
import type { PrepareWaiverInput } from "@/lib/lien-waivers/invoice-waiver";

export interface WaiverInvoiceSource {
  projectName: string;
  preview: { data: ArcInvoiceDocumentData; lines: ArcInvoiceLine[] };
}

/** Ignore save timestamps, recipient edits and preview-only payment controls. */
export function waiverInvoiceRevision({
  projectName,
  preview: { data, lines },
}: WaiverInvoiceSource) {
  return JSON.stringify({
    projectName,
    number: data.invoiceNumber,
    title: data.projectName,
    from: data.fromLines,
    customer: data.billToLines,
    subtotal: data.subtotalCents,
    tax: data.taxCents,
    total: data.totalCents,
    notes: data.notes,
    lines,
  });
}

/** Shared fields are derived, never copied into a second editable form. */
export function withInvoiceWaiverFields(
  input: PrepareWaiverInput,
  source: WaiverInvoiceSource,
  customAmount: boolean,
): PrepareWaiverInput {
  const customer = source.preview.data.billToLines[0] ?? "";
  return {
    ...input,
    project_name: source.projectName,
    claimant_name: source.preview.data.fromLines[0] ?? "",
    customer_name: customer,
    // Preserve a separately identified owner, otherwise follow the customer.
    owner_name:
      !input.owner_name || input.owner_name === input.customer_name
        ? customer
        : input.owner_name,
    amount_cents: customAmount
      ? input.amount_cents
      : source.preview.data.totalCents,
  };
}
