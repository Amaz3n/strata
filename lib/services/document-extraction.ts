import "server-only"

import { z } from "zod"

import {
  collectFieldProvenance,
  normalizeRegion,
  PROVENANCE_FIELDS,
  type DocumentRegion,
  type ProvenanceField,
} from "@/lib/ai/field-provenance"
import { reconcileInvoice, reconcilePayApplication, toCents } from "@/lib/financials/invoice-reconcile"
import { runAiObject, type AiFilePart } from "@/lib/services/ai/gateway"
import { loadVendorExtractionHints } from "@/lib/services/vendor-extraction-memory"
import {
  detectDuplicateSuspicion,
  formatExpectationsForPrompt,
  loadExtractionExpectations,
  EMPTY_EXPECTATIONS,
} from "@/lib/services/document-extraction-context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Reading money documents: job-site receipts, vendor invoices, and the coding
 * that turns them into ledger entries.
 *
 * This replaces a hand-rolled Gemini REST client that scraped JSON out of prose.
 * Three things changed, and each one removed a class of bug rather than a bug:
 *
 * 1. STRUCTURED OUTPUT. The schema is enforced by the provider, so the fenced-
 *    block regex, the brace-slicing, and the ten-aliases-per-field normaliser
 *    that existed to survive schema drift are all gone.
 *
 * 2. THE MODEL READS, CODE COUNTS. Amounts come back as the decimal number
 *    printed on the page (1234.56), and cents conversion happens here. The old
 *    schema asked for integer cents and guessed the unit from whether a decimal
 *    point was present — so a total of "1234" was read as $12.34. Asking for
 *    what is printed makes that whole category of error unrepresentable.
 *
 * 3. ONE PASS, THEN ARITHMETIC. Header and line items come from a single call.
 *    That halves cost and latency versus scanning twice, and — more importantly
 *    — it is what lets us check the lines against the total. A document whose
 *    numbers do not reconcile escalates to a stronger model instead of being
 *    handed to a bookkeeper as though it were fine.
 */

const MAX_EXTRACTION_SIZE = 20 * 1024 * 1024
const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
])

const MAX_EXTRACTED_LINES = 200

// ---------------------------------------------------------------------------
// Model-facing schemas
//
// Deliberately plain: no z.preprocess, no coercion, no aliases. Structured
// output guarantees the shape, so anything clever here is a smell.
// ---------------------------------------------------------------------------

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be YYYY-MM-DD")
  .nullable()

const confidence = z.enum(["high", "medium", "low"])

/**
 * Where a value sits on the page, so a reviewer can click a filled field and see
 * the ink it came from. Normalized 0..1 from the top-left of the page, because
 * asking for pixels would be asking the model to know the render resolution.
 */
const regionSchema = z.object({
  page: z.number().int().min(1).describe("1-based page the value appears on"),
  x0: z.number().describe("Left edge, 0..1 across the page width"),
  y0: z.number().describe("Top edge, 0..1 down the page height"),
  x1: z.number().describe("Right edge, 0..1"),
  y1: z.number().describe("Bottom edge, 0..1"),
})

const lineSchema = z.object({
  description: z.string().describe("The line's printed description"),
  quantity: z.number().nullable().describe("Quantity as printed, or null"),
  unit: z.string().nullable().describe("Short unit label such as ea, lf, sf, hr, ls"),
  unit_price: z.number().nullable().describe("Per-unit price in currency units, e.g. 12.50"),
  amount: z.number().describe("Extended amount for this line in currency units. Negative for credits."),
  region: regionSchema.nullable().describe("Tight box around this line's row, or null if unsure"),
})

/**
 * What kind of document arrived. This is a router, not a label: a statement or
 * a lien waiver must not become a payable, a credit memo is negative, and a pay
 * application has its own footing rules that no ordinary invoice has.
 */
export const PAYABLE_DOCUMENT_TYPES = [
  "material_invoice",
  "subcontractor_invoice",
  "pay_application",
  "rental_invoice",
  "credit_memo",
  "receipt",
  "statement",
  "lien_waiver",
  "other",
] as const
export type PayableDocumentType = (typeof PAYABLE_DOCUMENT_TYPES)[number]

/** Types that legitimately become a vendor bill. */
const BILLABLE_DOCUMENT_TYPES = new Set<PayableDocumentType>([
  "material_invoice",
  "subcontractor_invoice",
  "pay_application",
  "rental_invoice",
  "credit_memo",
])

export function isBillableDocumentType(type: PayableDocumentType) {
  return BILLABLE_DOCUMENT_TYPES.has(type)
}

/** AIA G702-style continuation figures. Null on every other document type. */
const payApplicationSchema = z.object({
  application_number: z.string().nullable(),
  period_from: isoDate,
  period_to: isoDate,
  previous_completed: z.number().nullable().describe("Line 3: previously completed work"),
  this_period: z.number().nullable().describe("Work completed this period"),
  materials_stored: z.number().nullable(),
  total_completed_stored: z.number().nullable().describe("Line 4"),
  retainage: z.number().nullable().describe("Line 5: total retainage"),
  total_earned_less_retainage: z.number().nullable().describe("Line 6"),
  less_previous_certificates: z.number().nullable().describe("Line 7"),
  current_payment_due: z.number().nullable().describe("Line 8: amount actually due this application"),
})

const invoiceSchema = z.object({
  document_type: z
    .enum(PAYABLE_DOCUMENT_TYPES)
    .describe(
      "What this document is. A statement lists several invoices and is not itself a bill. " +
        "A lien waiver is a signed release, not a bill. A pay application is an AIA-style " +
        "G702/G703 progress billing.",
    ),
  vendor_id: z
    .string()
    .nullable()
    .describe("Id from the known-vendor list when the vendor matches one, otherwise null"),
  vendor_name: z.string().nullable(),
  bill_number: z.string().nullable().describe("Invoice, bill, or reference number"),
  bill_date: isoDate,
  due_date: isoDate,
  subtotal: z.number().nullable().describe("Subtotal before tax, in currency units"),
  tax: z.number().nullable().describe("Tax amount in currency units"),
  total: z.number().nullable().describe("Final amount due in currency units, e.g. 1234.56"),
  description: z.string().nullable().describe("Short work or material summary"),
  lines: z.array(lineSchema).describe("Every billed line. Exclude subtotal, tax and total rows."),
  pay_application: payApplicationSchema
    .nullable()
    .describe("Populate only when document_type is pay_application, otherwise null"),
  provenance: z
    .array(regionSchema.extend({ field: z.enum(PROVENANCE_FIELDS) }))
    .describe(
      "One entry per header field you could locate on the page. Omit a field rather than " +
        "guessing at its position, and never return a box covering most of the page.",
    ),
  confidence,
  notes: z.array(z.string()),
})

const receiptSchema = z.object({
  vendor_name: z.string().nullable(),
  expense_date: isoDate,
  subtotal: z.number().nullable(),
  tax: z.number().nullable(),
  total: z.number().nullable().describe("Final amount paid in currency units"),
  payment_method: z
    .enum(["cash", "credit_card", "check", "ach", "company_card", "reimbursable_personal", "other"])
    .nullable(),
  description: z.string().nullable(),
  confidence,
  notes: z.array(z.string()),
})

/**
 * No `reason` field on purpose. Coding is applied to fields the bookkeeper is
 * already looking at and can change in one click, so a sentence explaining the
 * choice bought nothing and was billed as output tokens on every single bill.
 */
const codingSchema = z.object({
  cost_code_id: z.string().nullable(),
  budget_line_id: z.string().nullable(),
  expense_account_id: z.string().nullable(),
  ap_account_id: z.string().nullable(),
  confidence,
})

const lineMatchSchema = z.object({
  decisions: z.array(
    z.object({
      index: z.number().int().min(0),
      commitment_line_id: z.string().nullable(),
      confidence,
      reason: z.string().max(200),
    }),
  ),
})

// ---------------------------------------------------------------------------
// Public DTOs
// ---------------------------------------------------------------------------

export type ExtractionConfidence = "high" | "medium" | "low"

export interface ExtractedInvoiceLineItem {
  description: string
  quantity: number | null
  unit: string | null
  unitPriceCents: number | null
  amountCents: number
  /** Where this row sits on the page. Advisory — null whenever the model was unsure. */
  region: DocumentRegion | null
}

export interface ExtractedExpenseReceipt {
  vendorName: string | null
  expenseDate: string | null
  totalDollars: number | null
  taxDollars: number | null
  paymentMethod:
    | "cash"
    | "credit_card"
    | "check"
    | "ach"
    | "company_card"
    | "reimbursable_personal"
    | "other"
    | null
  description: string | null
  confidence: ExtractionConfidence
  notes: string[]
  model: string
}

export interface ExtractedPayApplication {
  applicationNumber: string | null
  periodFrom: string | null
  periodTo: string | null
  previousCompletedDollars: number | null
  thisPeriodDollars: number | null
  materialsStoredDollars: number | null
  totalCompletedStoredDollars: number | null
  retainageDollars: number | null
  totalEarnedLessRetainageDollars: number | null
  lessPreviousCertificatesDollars: number | null
  currentPaymentDueDollars: number | null
}

export interface ExtractedPayableInvoice {
  /** What the router decided this document is. */
  documentType: PayableDocumentType
  /** False for statements, lien waivers and anything else that is not a bill. */
  billable: boolean
  /** Matched against the org's vendor list; null when the vendor is new. */
  vendorId: string | null
  vendorName: string | null
  billNumber: string | null
  billDate: string | null
  dueDate: string | null
  totalDollars: number | null
  subtotalDollars: number | null
  taxDollars: number | null
  description: string | null
  confidence: ExtractionConfidence
  notes: string[]
  model: string
  /** Every billed line, already reconciled against the total where possible. */
  lines: ExtractedInvoiceLineItem[]
  /** Present only for pay applications. */
  payApplication: ExtractedPayApplication | null
  /** True when the line amounts do not sum to the printed total. */
  sumMismatch: boolean
  /** True when this looks like a payable Arc already holds. */
  duplicateSuspected: boolean
  duplicateReason: string | null
  /** True when a stronger model was needed to produce a reconciling read. */
  escalated: boolean
  /**
   * Where each header field was read from, for click-to-highlight review.
   * Advisory only: nothing computes off a box, and a field is simply absent
   * when the model could not place it credibly.
   */
  provenance: Partial<Record<ProvenanceField, DocumentRegion>>
}

export interface PayableAiCodingSuggestion {
  costCodeId: string | null
  budgetLineId: string | null
  expenseAccountId: string | null
  apAccountId: string | null
  confidence: ExtractionConfidence
  model: string
}

export interface InvoiceLineMatchArbitration {
  index: number
  commitmentLineId: string | null
  confidence: ExtractionConfidence
  reason: string
}

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------

function sniffMimeType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null
  if (bytes.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png"
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp"
  }
  const brand = bytes.subarray(4, 12).toString("ascii")
  if (brand.startsWith("ftyp") && /heic|heix|hevc|hevx|mif1|msf1/i.test(brand)) return "image/heic"
  return null
}

/** Magic bytes beat the browser-supplied type, which phones routinely get wrong. */
function normalizeMimeType(declared: string | null | undefined, fileName: string, bytes: Buffer) {
  const sniffed = sniffMimeType(bytes)
  if (sniffed) return sniffed

  const normalized = declared?.trim().toLowerCase()
  if (normalized === "image/jpg" || normalized === "image/pjpeg") return "image/jpeg"
  if (normalized && SUPPORTED_MIME_TYPES.has(normalized)) return normalized

  const lower = fileName.toLowerCase()
  if (lower.endsWith(".pdf")) return "application/pdf"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".heic")) return "image/heic"
  if (lower.endsWith(".heif")) return "image/heif"
  return "application/octet-stream"
}

async function toFilePart(file: File, label: string): Promise<AiFilePart> {
  if (!file || file.size === 0) throw new Error(`Choose ${label} to scan`)
  if (file.size > MAX_EXTRACTION_SIZE) {
    throw new Error(`${label[0].toUpperCase()}${label.slice(1)} scanning supports files up to 20MB`)
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const mediaType = normalizeMimeType(file.type, file.name, bytes)
  if (!SUPPORTED_MIME_TYPES.has(mediaType)) {
    throw new Error(`${label[0].toUpperCase()}${label.slice(1)} scanning supports images and PDFs`)
  }

  return { data: bytes, mediaType, filename: file.name || `${label}.bin` }
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

function cleanText(value: string | null | undefined, max = 500) {
  const cleaned = value?.trim()
  return cleaned ? cleaned.slice(0, max) : null
}

function cleanNotes(notes: string[]) {
  return notes.map((note) => note.trim()).filter(Boolean).slice(0, 5)
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const INVOICE_SYSTEM = [
  "You read construction vendor invoices and bills.",
  "Report only what is printed on the document. Never compute a value the document does not show,",
  "and never invent a line to make numbers balance — an honest mismatch is more useful than a tidy guess.",
  "All monetary amounts are the decimal numbers as printed, for example 1234.56, not cents.",
  "Exclude subtotal, tax, freight-summary and total rows from lines; those belong in their own fields.",
  "Use null for anything not visible, and explain the gap in notes.",
].join(" ")

const RECEIPT_SYSTEM = [
  "You read job-site expense receipts.",
  "Report only what is printed. All monetary amounts are decimal numbers as printed, for example 42.75, not cents.",
  "Use null for anything not visible, and explain the gap in notes.",
].join(" ")

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

/**
 * Turn a gateway failure into an error a human can act on.
 *
 * This used to collapse every reason into "Could not scan invoice", which threw
 * away the one thing the gateway went to the trouble of producing. A scan that
 * failed because the model is unavailable, because the org's AI kill switch is
 * off, and because the document genuinely could not be read are three different
 * problems with three different fixes, and they all read identically.
 *
 * The user-facing sentence stays short and non-technical; the provider's own
 * message goes to the server log, where it is the difference between "reproduce
 * it locally and bisect" and "read the line".
 */
function extractionError(
  kind: "invoice" | "receipt",
  result: { reason: string; message: string },
): Error {
  console.error(`[document-extraction] ${kind} scan failed (${result.reason}): ${result.message}`)

  const noun = kind === "invoice" ? "Invoice" : "Receipt"
  switch (result.reason) {
    case "not_configured":
      return new Error(`${noun} scanning is not configured. Set a model for document extraction in Admin -> AI.`)
    case "disabled":
      return new Error("AI features are turned off for this organization.")
    case "timeout":
      return new Error(`The ${kind} took too long to read. Try a smaller or clearer file.`)
    case "verification_failed":
      return new Error(`The numbers on this ${kind} did not reconcile after several attempts. Enter it manually.`)
    case "invalid_output":
      return new Error(`Could not read this ${kind}. If it is a photo, try a flatter, better-lit shot.`)
    default:
      // Provider-side problems (model unavailable, quota, rate limit) are the
      // operator's to fix, so say where to look rather than blaming the file.
      return new Error(`Could not scan ${kind === "invoice" ? "invoice" : "receipt"} — the AI provider rejected the request. Check Admin -> AI for the configured models.`)
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Read a vendor invoice: header and every billed line, in one pass, verified.
 */
export async function extractPayableInvoiceFromFile(
  file: File,
  options: { orgId?: string; entityId?: string; projectId?: string | null; companyId?: string | null } = {},
): Promise<ExtractedPayableInvoice> {
  const filePart = await toFilePart(file, "an invoice")

  // Everything Arc already knows, loaded before the model looks at the page.
  // Best-effort: a failure here means an unaided read, not a failed scan.
  let expectations = EMPTY_EXPECTATIONS
  if (options.orgId) {
    expectations = await loadExtractionExpectations({
      supabase: createServiceSupabaseClient(),
      orgId: options.orgId,
      projectId: options.projectId ?? null,
    }).catch(() => EMPTY_EXPECTATIONS)
  }
  const expectationBlock = formatExpectationsForPrompt(expectations)
  // What a human previously had to fix on this vendor's invoices.
  const vendorHints = options.orgId && options.companyId
    ? await loadVendorExtractionHints({
        supabase: createServiceSupabaseClient(),
        orgId: options.orgId,
        companyId: options.companyId,
      }).catch(() => "")
    : ""

  const result = await runAiObject({
    feature: "document_extraction",
    schema: invoiceSchema,
    system: INVOICE_SYSTEM,
    prompt: [
      "First decide what this document is, then extract it.",
      "Extract the header fields and every billed line item. If the document has",
      "multiple pages, include lines from all of them.",
      "For a pay application, also fill the pay_application block from the G702 face sheet.",
      "For each header field you can locate, add a provenance entry with a TIGHT box around the",
      "printed value itself — not the row, not the block, and never most of the page. Omit the",
      "entry when you cannot place the value confidently; a missing box costs nothing, a wrong",
      "one sends a reviewer to the wrong part of the page.",
      expectationBlock,
      vendorHints,
    ]
      .filter(Boolean)
      .join("\n\n"),
    files: [filePart],
    orgId: options.orgId ?? null,
    entityType: "vendor_bill",
    entityId: options.entityId,
    // Arithmetic decides whether this read is good enough to keep, and which
    // arithmetic applies depends on what the router says the document is.
    verify: (value) => {
      if (!isBillableDocumentType(value.document_type)) {
        // A statement or waiver has no total to reconcile; identifying it
        // correctly IS the result, so escalating would only burn spend.
        return { ok: true }
      }

      if (value.document_type === "pay_application" && value.pay_application) {
        const app = value.pay_application
        const verdict = reconcilePayApplication({
          previousCompletedCents: toCents(app.previous_completed),
          thisPeriodCents: toCents(app.this_period),
          materialsStoredCents: toCents(app.materials_stored),
          totalCompletedStoredCents: toCents(app.total_completed_stored),
          retainageCents: toCents(app.retainage),
          totalEarnedLessRetainageCents: toCents(app.total_earned_less_retainage),
          lessPreviousCertificatesCents: toCents(app.less_previous_certificates),
          currentPaymentDueCents: toCents(app.current_payment_due),
        })
        if (!verdict.ok) return { ok: false, message: verdict.message }
      }

      const verdict = reconcileInvoice({
        totalCents: toCents(value.total),
        subtotalCents: toCents(value.subtotal),
        taxCents: toCents(value.tax),
        lines: value.lines.map((line) => ({
          amountCents: toCents(line.amount) ?? 0,
          quantity: line.quantity,
          unitPriceCents: toCents(line.unit_price),
        })),
      })
      return { ok: verdict.ok, message: verdict.message }
    },
  })

  if (!result.ok) throw extractionError("invoice", result)

  const value = result.object
  const lines: ExtractedInvoiceLineItem[] = value.lines
    .slice(0, MAX_EXTRACTED_LINES)
    .map((line) => ({
      description: cleanText(line.description) ?? "Line",
      quantity: line.quantity,
      unit: cleanText(line.unit, 40)?.toLowerCase() ?? null,
      unitPriceCents: toCents(line.unit_price),
      amountCents: toCents(line.amount) ?? 0,
      region: normalizeRegion(line.region),
    }))

  const totalCents = toCents(value.total)
  const verdict = reconcileInvoice({
    totalCents,
    subtotalCents: toCents(value.subtotal),
    taxCents: toCents(value.tax),
    lines,
  })

  // The model may only pick a vendor from the list it was shown; anything else
  // is discarded, exactly as with cost-code and commitment-line selection.
  const vendorId =
    value.vendor_id && expectations.vendors.some((vendor) => vendor.id === value.vendor_id)
      ? value.vendor_id
      : null

  const duplicate = detectDuplicateSuspicion({
    billNumber: value.bill_number,
    companyId: vendorId,
    totalCents,
    billDate: value.bill_date,
    recentBills: expectations.recentBills,
  })

  const billable = isBillableDocumentType(value.document_type)
  const notes = cleanNotes(value.notes)

  // The ladder can still exhaust without reconciling; when it does, the mismatch
  // is surfaced as data rather than silently accepted.
  if (!verdict.ok && verdict.message) notes.unshift(verdict.message)
  if (duplicate.isSuspected && duplicate.reason) notes.unshift(duplicate.reason)
  if (!billable) {
    notes.unshift(
      value.document_type === "statement"
        ? "This looks like a vendor statement, not an invoice. Statements list bills that were sent separately."
        : value.document_type === "lien_waiver"
          ? "This looks like a lien waiver, not an invoice."
          : "This does not look like a payable invoice.",
    )
  }

  const app = value.pay_application

  return {
    documentType: value.document_type,
    billable,
    vendorId,
    vendorName: cleanText(value.vendor_name),
    billNumber: cleanText(value.bill_number, 120),
    billDate: value.bill_date,
    dueDate: value.due_date,
    totalDollars: value.total,
    subtotalDollars: value.subtotal,
    taxDollars: value.tax,
    description: cleanText(value.description),
    confidence: value.confidence,
    notes: notes.slice(0, 6),
    model: result.meta.model,
    lines,
    payApplication:
      value.document_type === "pay_application" && app
        ? {
            applicationNumber: cleanText(app.application_number, 60),
            periodFrom: app.period_from,
            periodTo: app.period_to,
            previousCompletedDollars: app.previous_completed,
            thisPeriodDollars: app.this_period,
            materialsStoredDollars: app.materials_stored,
            totalCompletedStoredDollars: app.total_completed_stored,
            retainageDollars: app.retainage,
            totalEarnedLessRetainageDollars: app.total_earned_less_retainage,
            lessPreviousCertificatesDollars: app.less_previous_certificates,
            currentPaymentDueDollars: app.current_payment_due,
          }
        : null,
    sumMismatch: !verdict.ok,
    duplicateSuspected: duplicate.isSuspected,
    duplicateReason: duplicate.reason ?? null,
    escalated: result.meta.escalated,
    provenance: collectFieldProvenance(value.provenance),
  }
}

export async function extractExpenseReceiptFromFile(
  file: File,
  options: { orgId?: string; entityId?: string } = {},
): Promise<ExtractedExpenseReceipt> {
  const filePart = await toFilePart(file, "a receipt")

  const result = await runAiObject({
    feature: "document_extraction",
    schema: receiptSchema,
    system: RECEIPT_SYSTEM,
    prompt: "Extract this job-site expense receipt.",
    files: [filePart],
    orgId: options.orgId ?? null,
    entityType: "expense",
    entityId: options.entityId,
    // A receipt has no line detail to reconcile; the only checkable claim is
    // that a printed subtotal and tax compose the printed total.
    verify: (value) => {
      const verdict = reconcileInvoice({
        totalCents: toCents(value.total),
        subtotalCents: toCents(value.subtotal),
        taxCents: toCents(value.tax),
        lines: [],
      })
      return { ok: verdict.ok, message: verdict.message }
    },
  })

  if (!result.ok) throw extractionError("receipt", result)

  const value = result.object
  return {
    vendorName: cleanText(value.vendor_name),
    expenseDate: value.expense_date,
    totalDollars: value.total,
    taxDollars: value.tax,
    paymentMethod: value.payment_method,
    description: cleanText(value.description),
    confidence: value.confidence,
    notes: cleanNotes(value.notes),
    model: result.meta.model,
  }
}

// ---------------------------------------------------------------------------
// Constrained-choice classification
//
// Both helpers below hand the model a closed list of IDs and re-check every ID
// it returns. A hallucinated ID becomes null rather than a wrong ledger entry.
// ---------------------------------------------------------------------------

export async function suggestPayableCodingFromInvoice(input: {
  orgId?: string
  vendorName?: string | null
  description?: string | null
  costCodes: Array<{ id: string; label: string }>
  budgetLines: Array<{ id: string; label: string }>
  expenseAccounts: Array<{ id: string; label: string }>
  apAccounts: Array<{ id: string; label: string }>
}): Promise<PayableAiCodingSuggestion | null> {
  if (!input.vendorName?.trim() && !input.description?.trim()) return null

  const optionLines = (label: string, rows: Array<{ id: string; label: string }>) =>
    `${label}:\n${rows.slice(0, 200).map((row) => `${row.id} | ${row.label}`).join("\n") || "none"}`

  const result = await runAiObject({
    feature: "document_extraction",
    schema: codingSchema,
    system:
      "You choose construction accounts-payable coding. Every ID you return must appear verbatim in the " +
      "matching option list. Use null when no choice is defensible. Prefer a specific trade or material " +
      "code over a generic category.",
    prompt: [
      `Vendor: ${input.vendorName?.trim() || "unknown"}`,
      `Invoice summary: ${input.description?.trim() || "none"}`,
      optionLines("Cost codes", input.costCodes),
      optionLines("Budget lines", input.budgetLines),
      optionLines("Expense accounts", input.expenseAccounts),
      optionLines("Accounts payable accounts", input.apAccounts),
    ].join("\n\n"),
    orgId: input.orgId ?? null,
    entityType: "vendor_bill",
    // Coding is a suggestion a human reviews; escalating it is not worth the spend.
    allowEscalation: false,
  })

  if (!result.ok) return null

  const validId = (value: string | null, rows: Array<{ id: string }>) =>
    value && rows.some((row) => row.id === value) ? value : null

  return {
    costCodeId: validId(result.object.cost_code_id, input.costCodes),
    budgetLineId: validId(result.object.budget_line_id, input.budgetLines),
    expenseAccountId: validId(result.object.expense_account_id, input.expenseAccounts),
    apAccountId: validId(result.object.ap_account_id, input.apAccounts),
    confidence: result.object.confidence,
    model: result.meta.model,
  }
}

/**
 * Arbiter for invoice lines the deterministic matcher found genuinely ambiguous.
 * One call for the whole bill; the model may only pick from each line's own
 * shortlist, and every returned ID is validated again here.
 */
export async function arbitrateInvoiceLineMatches(input: {
  orgId?: string
  ambiguousLines: Array<{
    index: number
    description: string
    quantity: number | null
    unit: string | null
    amountCents: number
    candidates: Array<{ id: string; label: string; remainingCents: number }>
  }>
}): Promise<{ decisions: InvoiceLineMatchArbitration[]; model: string } | null> {
  if (input.ambiguousLines.length === 0) return null

  const lineBlocks = input.ambiguousLines.map((line) =>
    [
      `Invoice line index ${line.index}: "${line.description}"` +
        `${line.quantity != null ? ` (qty ${line.quantity}${line.unit ? ` ${line.unit}` : ""})` : ""}` +
        ` for ${(line.amountCents / 100).toFixed(2)}`,
      `Candidates:\n${line.candidates
        .map((c) => `${c.id} | ${c.label} | ${(c.remainingCents / 100).toFixed(2)} remaining`)
        .join("\n")}`,
    ].join("\n"),
  )

  const result = await runAiObject({
    feature: "document_extraction",
    schema: lineMatchSchema,
    system:
      "You match construction invoice lines to the commitment (purchase order or subcontract) line they bill " +
      "against. commitment_line_id must appear verbatim in that line's candidate list. Use null when no " +
      "candidate clearly covers the billed work. Keep reason under 20 words.",
    prompt: lineBlocks.join("\n\n"),
    orgId: input.orgId ?? null,
    entityType: "vendor_bill",
    allowEscalation: false,
  })

  if (!result.ok) return null

  const candidatesByIndex = new Map(input.ambiguousLines.map((line) => [line.index, line.candidates]))
  const decisions = result.object.decisions
    .filter((entry) => candidatesByIndex.has(entry.index))
    .map((entry) => {
      const candidates = candidatesByIndex.get(entry.index) ?? []
      const valid = entry.commitment_line_id && candidates.some((c) => c.id === entry.commitment_line_id)
      return {
        index: entry.index,
        commitmentLineId: valid ? entry.commitment_line_id : null,
        confidence: entry.confidence,
        reason: entry.reason.trim(),
      }
    })

  return { decisions, model: result.meta.model }
}
