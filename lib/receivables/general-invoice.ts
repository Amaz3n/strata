import type { InvoiceInput } from "@/lib/validation/invoices"

export function validateGeneralInvoice(input: Pick<InvoiceInput, "project_id" | "customer_id" | "qbo_customer_id" | "source_type" | "source_draw_id" | "source_change_order_id" | "source_pay_application_id" | "metadata">): string | null {
  if (input.metadata?.invoice_kind === "earnest_deposit" && ((input.source_type && input.source_type !== "manual") || input.source_draw_id || input.source_change_order_id || input.source_pay_application_id)) return "Deposit requests cannot bill project work."
  if (input.project_id) return null
  if (input.metadata?.invoice_kind === "earnest_deposit" && !input.customer_id) return "Choose an Arc customer for a deposit request."
  if (!input.customer_id && !input.qbo_customer_id) return "Choose a customer for general billing."
  if ((input.source_type && input.source_type !== "manual") || input.source_draw_id || input.source_change_order_id || input.source_pay_application_id) return "Project billing sources require a project."
  if (input.metadata?.invoice_kind === "closing") return "Closing invoices require a project."
  return null
}
