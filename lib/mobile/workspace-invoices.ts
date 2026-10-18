import { z } from "zod"
import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { allowed, requireModule } from "@/lib/mobile/workspace"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { invoiceInputSchema, invoiceLineInputSchema } from "@/lib/validation/invoices"

// Native drafts cannot smuggle issuance intent, billing sources, arbitrary metadata,
// customer IDs, accounting mappings, or costs belonging to another project.
export const mobileInvoiceDraftSchema = invoiceInputSchema.pick({ project_id: true, invoice_number: true, title: true, issue_date: true, due_date: true, notes: true, tax_rate: true }).extend({
  project_id: z.string().uuid(),
  invoice_number: z.string().trim().min(1).max(80),
  title: z.string().trim().min(3).max(200),
  issue_date: z.string().date(),
  due_date: z.string().date(),
  lines: z.array(invoiceLineInputSchema.pick({ description: true, quantity: true, unit: true, unit_cost: true, taxable: true }).extend({ id: z.string().uuid().optional(), description: z.string().trim().min(1).max(1000), quantity: z.number().finite().min(0.01).max(1000000), unit_cost: z.number().finite().min(0).max(100000000) })).min(1).max(100),
}).refine(input => input.due_date >= input.issue_date, { message: "Due date must be on or after the issue date.", path: ["due_date"] })

export async function createMobileInvoiceDraft(context: MobileOrgContext, value: unknown) {
  const input = mobileInvoiceDraftSchema.parse(value)
  await requireModule(context, "billing", input.project_id)
  if (!await allowed(context, "invoice.write", input.project_id)) throw new MobileAPIError(403, "invoice_forbidden", "You cannot create invoices for this project.")
  return runWithServiceOrgContext(context.serviceContext, async () => (await import("@/lib/services/invoices")).createInvoice({ orgId: context.orgId, context: context.serviceContext, input: { ...input, lines: input.lines.map(({ id: _id, ...line }) => line), issue: false, source_type: "manual" } }))
}


export function canEditMobileInvoice(invoice: import("@/lib/types").Invoice) {
  return ["draft", "saved"].includes(invoice.status) && !invoice.sent_at && !invoice.client_visible && !invoice.qbo_id
    && (invoice.source_type ?? invoice.metadata?.source_type ?? "manual") === "manual"
}

async function requireDraft(context: MobileOrgContext, projectId: string, invoiceId: string) {
  await requireModule(context, "billing", projectId)
  if (!await allowed(context, "invoice.write", projectId)) throw new MobileAPIError(403, "invoice_forbidden", "You cannot edit invoices for this project.")
  const invoice = await (await import("@/lib/services/invoices")).getInvoiceWithLines(invoiceId, context.orgId)
  if (!invoice || invoice.project_id !== projectId) throw new MobileAPIError(404, "invoice_not_found", "Invoice not found in this project.")
  if (!canEditMobileInvoice(invoice)) throw new MobileAPIError(409, "invoice_locked", "This invoice cannot be edited as a manual draft.")
  return invoice
}

export async function loadMobileInvoiceDraft(context: MobileOrgContext, projectId: string, invoiceId: string) {
  return runWithServiceOrgContext(context.serviceContext, async () => {
    const invoice = await requireDraft(context, projectId, invoiceId)
    return { revision: invoice.updated_at, input: {
      project_id: projectId, invoice_number: invoice.invoice_number, title: invoice.title,
      issue_date: invoice.issue_date ?? "", due_date: invoice.due_date ?? "", notes: invoice.notes ?? "",
      tax_rate: invoice.totals?.tax_rate ?? invoice.metadata?.tax_rate ?? 0,
      lines: (invoice.lines ?? []).map(line => ({ id: line.id, description: line.description, quantity: line.quantity, unit: line.unit ?? "unit", unit_cost: line.unit_cost_cents / 100, taxable: line.taxable ?? true })),
    } }
  })
}

export async function updateMobileInvoiceDraft(context: MobileOrgContext, invoiceId: string, value: unknown) {
  const parsed = z.object({ revision: z.string().min(1), input: mobileInvoiceDraftSchema }).parse(value)
  return runWithServiceOrgContext(context.serviceContext, async () => {
    const existing = await requireDraft(context, parsed.input.project_id, invoiceId)
    if (existing.updated_at !== parsed.revision) throw new MobileAPIError(409, "invoice_changed", "This invoice changed. Reload it before saving.")
    const used = new Set<string>()
    const lines = parsed.input.lines.map(line => {
      const previous = line.id ? existing.lines?.find(candidate => candidate.id === line.id) : undefined
      if (line.id && (!previous || used.has(line.id))) throw new MobileAPIError(422, "invalid_line", "Invoice lines must belong to this draft and cannot be repeated.")
      if (line.id) used.add(line.id)
      // Restore accounting links from the server's original line, never the client.
      return { ...previous, ...line, cost_code_id: previous?.cost_code_id ?? undefined,
        cost_cents: previous?.cost_cents ?? undefined, markup_cents: previous?.markup_cents ?? undefined }
    })
    const metadata = existing.metadata ?? {}
    const input = invoiceInputSchema.parse({ ...parsed.input, lines, issue: false, source_type: "manual",
      customer_id: metadata.customer_id, customer_name: metadata.customer_name, customer_address: metadata.customer_address,
      qbo_customer_id: metadata.accounting_customer_ref?.id, qbo_customer_name: metadata.accounting_customer_ref?.name,
      qbo_income_account_id: metadata.qbo_income_account_id, qbo_income_account_name: metadata.qbo_income_account_name,
      tax_jurisdiction_id: metadata.tax_jurisdiction_id, tax_jurisdiction_name: metadata.tax_jurisdiction,
      payment_terms_days: metadata.payment_terms_days, discount_type: existing.totals?.discount_type, discount_value: existing.totals?.discount_value,
    })
    return (await import("@/lib/services/invoices")).updateInvoice({ invoiceId, input, orgId: context.orgId, expectedUpdatedAt: parsed.revision })
  })
}
