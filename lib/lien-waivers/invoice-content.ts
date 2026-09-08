import { createHash } from "node:crypto";
/** Delivery status and timestamps do not change the document being waived. */
export function invoiceWaiverContentHash(invoice: Record<string, any>): string {
  const metadata = invoice.metadata ?? {};
  return createHash("sha256")
    .update(
      JSON.stringify({
        project: invoice.project_id ?? null,
        number: invoice.invoice_number ?? null,
        title: invoice.title ?? null,
        total: invoice.total_cents ?? 0,
        subtotal: invoice.subtotal_cents ?? 0,
        tax: invoice.tax_cents ?? 0,
        customer: metadata.customer_id ?? null,
        customerName: metadata.customer_name ?? null,
        owner: metadata.owner_name ?? null,
        lines: (metadata.lines ?? []).map((line: Record<string, any>) => ({
          description: line.description ?? "", quantity: Number(line.quantity ?? 1),
          unit: line.unit ?? null, price: Number(line.unit_price_cents ?? 0),
        })),
        notes: invoice.notes ?? null,
      }),
    )
    .digest("hex");
}
