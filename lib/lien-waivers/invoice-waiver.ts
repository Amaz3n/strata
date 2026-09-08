import { z } from "zod"
import type { WaiverTemplateDraft } from "@/lib/templates/waiver-template"
import { INVOICE_WAIVER_TYPES, type InvoiceLienWaiver, type Payment, type PaymentReversal } from "@/lib/types"

export const WAIVER_PDF_LIMIT = 15 * 1024 * 1024
export const WAIVER_TEMPLATE_FOLDER = "/Financials/Waiver templates"
export const WAIVER_CONSENT = "I am authorized to sign for the claimant. I have reviewed this waiver and agree to sign it electronically."
export const WAIVER_FIELDS = {
  claimant_name: "Claimant / company", customer_name: "Customer", owner_name: "Property owner",
  property_description: "Property / lot", amount: "Payment amount", through_date: "Work through date",
  invoice_number: "Invoice number", exceptions: "Exceptions", signer_name: "Signature",
  signer_title: "Signer title", signed_date: "Signature date",
} as const
export type WaiverFieldKey = keyof typeof WAIVER_FIELDS
const fieldKeys = Object.keys(WAIVER_FIELDS) as [WaiverFieldKey, ...WaiverFieldKey[]]
export const waiverPlacementSchema = z.object({
  id: z.string().min(1).max(100), key: z.enum(fieldKeys), page: z.number().int().min(0).max(49),
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().min(0.03).max(1), height: z.number().min(0.01).max(0.5),
}).refine((f) => f.x + f.width <= 1.001 && f.y + f.height <= 1.001, "Keep fields inside the page")
export type WaiverPlacement = z.infer<typeof waiverPlacementSchema>

export const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date").refine((s) => {
  const d = new Date(`${s}T12:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s
}, "Choose a valid date")

export const prepareWaiverSchema = z.object({
  request_id: z.string().uuid(), invoice_id: z.string().uuid(),
  replaces_draft_id: z.string().uuid().optional(),
  source: z.enum(["arc", "template", "upload"]), template_id: z.string().uuid().optional(),
  waiver_type: z.enum(INVOICE_WAIVER_TYPES), amount_cents: z.number().int().positive().max(999_999_999_99),
  project_name: z.string().trim().max(300).default(""),
  through_date: dateOnlySchema, claimant_name: z.string().trim().min(2).max(200),
  customer_name: z.string().trim().min(2).max(200), owner_name: z.string().trim().min(2).max(200),
  property_description: z.string().trim().min(5).max(1000), jurisdiction: z.string().trim().max(2),
  exceptions: z.string().trim().max(4000).default(""),
  signer_name: z.string().trim().min(2).max(200), signer_title: z.string().trim().min(2).max(200),
  signed_date: dateOnlySchema.optional(), payment_id: z.string().uuid().optional(),
  payment_ids: z.array(z.string().uuid()).max(100).optional(),
  final_confirmed: z.boolean().default(false), received_confirmed: z.boolean().default(false),
}).superRefine((v, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message })
  if (v.source === "template" && !v.template_id) issue("template_id", "Choose a template")
  if (v.source === "upload" && !v.signed_date) issue("signed_date", "Record the signature date on the document")
  if (v.waiver_type.endsWith("final") && !v.final_confirmed) issue("final_confirmed", "Review remaining retainage, changes, and the scope being closed out")
  if (v.waiver_type.startsWith("unconditional") && (!v.received_confirmed || !(v.payment_id || v.payment_ids?.length))) {
    issue("payment_id", "Select a recorded payment and confirm the funds were received")
  }
})
export type PrepareWaiverInput = z.infer<typeof prepareWaiverSchema>

export const templateInputSchema = z.object({
  name: z.string().trim().min(2).max(100), waiver_type: z.enum(INVOICE_WAIVER_TYPES),
  scope: z.enum(["company", "project"]), preferred: z.boolean(),
  family_id: z.string().uuid().optional(), fields: z.array(waiverPlacementSchema).min(1).max(80),
}).superRefine((v, ctx) => {
  for (const key of ["signer_name", "signed_date"] as const) {
    if (!v.fields.some((f) => f.key === key)) ctx.addIssue({ code: "custom", path: ["fields"], message: `Place the ${WAIVER_FIELDS[key].toLowerCase()} field` })
  }
})
export type WaiverTemplateInput = z.infer<typeof templateInputSchema>
export type WaiverTemplate = WaiverTemplateInput & { id: string; version: number; created_at: string; project_id: string | null; editable?: WaiverTemplateDraft; status?: "draft" | "published" }

export type InvoiceWaiverWorkflow = {
  version: 2; lifecycle: "draft" | "signed"; source: PrepareWaiverInput["source"];
  document_path: string; file_id: string; file_name: string; sha256: string;
  input: PrepareWaiverInput; shared: boolean; template_name?: string; template_version?: number;
  template_path?: string; fields?: WaiverPlacement[]; prepared_at: string;
  signed_at?: string; signed_by?: string; recorded_by?: string; recorded_at?: string; consent?: string; payment_id?: string; payment_ids?: string[];
  invoice_revision: string | null; invoice_content_hash?: string;
  editable_template?: WaiverTemplateDraft; signing_document_id?: string; sharing_requested?: boolean; envelope_id?: string; needs_review?: boolean;
}

export function readWaiverWorkflow(waiver: Pick<InvoiceLienWaiver, "metadata">): InvoiceWaiverWorkflow | null {
  const value = waiver.metadata?.workflow as InvoiceWaiverWorkflow | undefined
  return value?.version === 2 ? value : null
}

export function isWaiverPublic(waiver: Pick<InvoiceLienWaiver, "metadata" | "status" | "waiver_type">): boolean {
  if (waiver.status === "void") return false
  const workflow = readWaiverWorkflow(waiver)
  if (workflow) return workflow.lifecycle === "signed" && workflow.shared === true
  if (waiver.metadata?.workflow) return false
  return waiver.status === "released" || waiver.waiver_type.startsWith("conditional")
}

/** Never infer covered work from an invoice's payment deadline. */
export function waiverThroughDate(invoice: { metadata?: Record<string, unknown> | null }, periodEnd?: string | null): string {
  for (const value of [periodEnd, invoice.metadata?.billing_period_end, invoice.metadata?.period_end, invoice.metadata?.through_date]) {
    if (dateOnlySchema.safeParse(value).success) return value as string
  }
  return ""
}

export function availableWaiverPayments(payments: Payment[], reversals: PaymentReversal[]) {
  return payments.filter((p, index) => payments.findIndex((other) => other.id === p.id) === index)
    .filter((p) => ["succeeded", "completed", "paid"].includes(p.status))
    .map((p) => ({ ...p, available_cents: Math.max(0, p.amount_cents - reversals
      .filter((r) => r.payment_id === p.id && ["pending", "succeeded"].includes(r.status))
      .reduce((sum, r) => sum + r.amount_cents, 0)) }))
    .filter((p) => p.available_cents > 0)
}

export function preferredWaiverTemplate(templates: WaiverTemplate[], kind: string) {
  return templates.filter((t) => t.waiver_type === kind && t.preferred)
    .sort((a, b) => Number(Boolean(b.project_id)) - Number(Boolean(a.project_id)) || b.created_at.localeCompare(a.created_at))[0]
}

export function waiverPaymentIds(value: { payment_id?: string; payment_ids?: string[] }): string[] {
  return [...new Set([...(value.payment_ids ?? []), ...(value.payment_id ? [value.payment_id] : [])])]
}
