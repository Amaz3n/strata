import "server-only"

import { z } from "zod"

import { getPlatformAiFeatureDefaultConfig } from "@/lib/services/ai-config"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const MAX_RECEIPT_EXTRACTION_SIZE = 10 * 1024 * 1024
const SUPPORTED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"])

const centsSchema = z.preprocess((value) => {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.-]/g, "")
    if (!cleaned) return null
    const numberValue = Number(cleaned)
    if (!Number.isFinite(numberValue)) return null
    return value.includes(".") ? Math.round(numberValue * 100) : Math.round(numberValue)
  }
  return value ?? null
}, z.number().int().min(0).nullable())

const dateSchema = z.preprocess((value) => normalizeDateValue(value), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable())

const paymentMethodSchema = z.preprocess((value) => {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (normalized.includes("card") || normalized.includes("visa") || normalized.includes("mastercard") || normalized.includes("amex")) {
    return "credit_card"
  }
  if (normalized.includes("cash")) return "cash"
  if (normalized.includes("check") || normalized.includes("cheque")) return "check"
  if (normalized.includes("ach")) return "ach"
  if (normalized.includes("company")) return "company_card"
  if (normalized.includes("personal") || normalized.includes("reimburs")) return "reimbursable_personal"
  if (normalized === "other") return "other"
  return null
}, z.enum(["cash", "credit_card", "check", "ach", "company_card", "reimbursable_personal", "other"]).nullable())

const confidenceSchema = z.preprocess((value) => {
  if (typeof value !== "string") return "low"
  const normalized = value.trim().toLowerCase()
  if (normalized === "high" || normalized === "medium" || normalized === "low") return normalized
  return "low"
}, z.enum(["high", "medium", "low"]))

const notesSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value
  if (typeof value === "string" && value.trim()) return [value]
  return []
}, z.array(z.string()))

const extractedReceiptSchema = z.object({
  vendor_name: z.string().nullable().default(null),
  expense_date: dateSchema.default(null),
  total_cents: centsSchema.default(null),
  tax_cents: centsSchema.default(null),
  payment_method: paymentMethodSchema.default(null),
  description: z.string().nullable().default(null),
  confidence: confidenceSchema.default("low"),
  notes: notesSchema.default([]),
})

const extractedPayableInvoiceSchema = z.object({
  vendor_name: z.string().nullable().default(null),
  bill_number: z.string().nullable().default(null),
  bill_date: dateSchema.default(null),
  due_date: dateSchema.default(null),
  total_cents: centsSchema.default(null),
  description: z.string().nullable().default(null),
  confidence: confidenceSchema.default("low"),
  notes: notesSchema.default([]),
})

export interface ExtractedExpenseReceipt {
  vendorName: string | null
  expenseDate: string | null
  totalDollars: number | null
  taxDollars: number | null
  paymentMethod: "cash" | "credit_card" | "check" | "ach" | "company_card" | "reimbursable_personal" | "other" | null
  description: string | null
  confidence: "high" | "medium" | "low"
  notes: string[]
  model: string
}

export interface ExtractedPayableInvoice {
  vendorName: string | null
  billNumber: string | null
  billDate: string | null
  dueDate: string | null
  totalDollars: number | null
  description: string | null
  confidence: "high" | "medium" | "low"
  notes: string[]
  model: string
}

export async function extractExpenseReceiptFromFile(file: File, options: { orgId?: string } = {}): Promise<ExtractedExpenseReceipt> {
  if (!file || file.size === 0) throw new Error("Choose a receipt to scan")
  if (file.size > MAX_RECEIPT_EXTRACTION_SIZE) {
    throw new Error("Receipt scanning supports files up to 10MB")
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const mimeType = normalizeMimeType(file.type, file.name, bytes)
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error("Receipt scanning supports images and PDFs")
  }

  const apiKey = getGeminiApiKey()
  if (!apiKey) {
    throw new Error("Receipt scanning is not configured")
  }

  const model = await getReceiptVisionModel(options.orgId)
  const rawText = await generateGeminiReceiptExtraction({
    apiKey,
    model,
    mimeType,
    base64: bytes.toString("base64"),
  })
  const parsed = parseReceiptJson(rawText)

  return {
    vendorName: cleanString(parsed.vendor_name),
    expenseDate: parsed.expense_date,
    totalDollars: centsToDollars(parsed.total_cents),
    taxDollars: centsToDollars(parsed.tax_cents),
    paymentMethod: parsed.payment_method,
    description: cleanString(parsed.description),
    confidence: parsed.confidence,
    notes: parsed.notes.map((note) => note.trim()).filter(Boolean).slice(0, 4),
    model,
  }
}

export async function extractPayableInvoiceFromFile(file: File, options: { orgId?: string } = {}): Promise<ExtractedPayableInvoice> {
  if (!file || file.size === 0) throw new Error("Choose an invoice to scan")
  if (file.size > MAX_RECEIPT_EXTRACTION_SIZE) {
    throw new Error("Invoice scanning supports files up to 10MB")
  }

  const bytes = Buffer.from(await file.arrayBuffer())
  const mimeType = normalizeMimeType(file.type, file.name, bytes)
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error("Invoice scanning supports images and PDFs")
  }

  const apiKey = getGeminiApiKey()
  if (!apiKey) {
    throw new Error("Invoice scanning is not configured")
  }

  const model = await getReceiptVisionModel(options.orgId)
  const rawText = await generateGeminiExtraction({
    apiKey,
    model,
    mimeType,
    base64: bytes.toString("base64"),
    prompt: [
      "Extract construction payable invoice or vendor bill data from this image or PDF.",
      "Return only JSON with these keys:",
      "vendor_name, bill_number, bill_date, due_date, total_cents, description, confidence, notes.",
      "bill_number should be the invoice number, bill number, or reference number if visible.",
      "bill_date and due_date must be YYYY-MM-DD or null.",
      "total_cents must be the final invoice amount due, including tax and discounts.",
      "description should be a short work/material summary, not a full line-item dump.",
      "confidence must be high, medium, or low.",
      "If a value is uncertain, use null and explain briefly in notes.",
    ].join("\n"),
    errorLabel: "invoice",
  })
  const parsed = parsePayableInvoiceJson(rawText)

  return {
    vendorName: cleanString(parsed.vendor_name),
    billNumber: cleanString(parsed.bill_number),
    billDate: parsed.bill_date,
    dueDate: parsed.due_date,
    totalDollars: centsToDollars(parsed.total_cents),
    description: cleanString(parsed.description),
    confidence: parsed.confidence,
    notes: parsed.notes.map((note) => note.trim()).filter(Boolean).slice(0, 4),
    model,
  }
}

function normalizeMimeType(mimeType: string | null | undefined, fileName: string, bytes?: Buffer) {
  const normalized = mimeType?.trim().toLowerCase()
  if (normalized === "image/jpg" || normalized === "image/pjpeg") return "image/jpeg"
  if (normalized && SUPPORTED_MIME_TYPES.has(normalized)) return normalized

  const sniffed = sniffReceiptMimeType(bytes)
  if (sniffed) return sniffed

  const lowerName = fileName.toLowerCase()
  if (lowerName.endsWith(".pdf")) return "application/pdf"
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg"
  if (lowerName.endsWith(".png")) return "image/png"
  if (lowerName.endsWith(".webp")) return "image/webp"
  if (lowerName.endsWith(".heic")) return "image/heic"
  if (lowerName.endsWith(".heif")) return "image/heif"
  if (normalized?.startsWith("image/")) return normalized
  return "application/octet-stream"
}

function sniffReceiptMimeType(bytes: Buffer | undefined) {
  if (!bytes || bytes.length < 12) return null

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
  if (brand.startsWith("ftyp") && /heic|heix|hevc|hevx|mif1|msf1/i.test(brand)) {
    return "image/heic"
  }

  return null
}

function getGeminiApiKey() {
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || null
}

async function getReceiptVisionModel(_orgId?: string) {
  try {
    const config = await getPlatformAiFeatureDefaultConfig({
      supabase: createServiceSupabaseClient(),
      feature: "document_extraction",
    })
    if (config.provider === "google" && config.model.trim()) {
      return config.model.trim()
    }
  } catch (error) {
    console.warn("[ReceiptExtraction] Failed to load platform AI defaults", error)
  }

  return (
    process.env.DOCUMENT_EXTRACTION_MODEL_DEFAULT ||
    process.env.GOOGLE_DOCUMENT_EXTRACTION_MODEL ||
    process.env.RECEIPT_VISION_MODEL ||
    process.env.GEMINI_RECEIPT_MODEL ||
    process.env.DRAWINGS_VISION_MODEL ||
    process.env.AI_DRAWINGS_VISION_MODEL ||
    process.env.GEMINI_VISION_MODEL ||
    process.env.GOOGLE_VISION_MODEL ||
    "gemini-2.5-flash-lite"
  ).trim()
}

async function generateGeminiReceiptExtraction({
  apiKey,
  model,
  mimeType,
  base64,
}: {
  apiKey: string
  model: string
  mimeType: string
  base64: string
}) {
  return generateGeminiExtraction({
    apiKey,
    model,
    mimeType,
    base64,
    prompt: [
      "Extract job-site expense receipt data from this image or PDF.",
      "Return only JSON with these keys:",
      "vendor_name, expense_date, total_cents, tax_cents, payment_method, description, confidence, notes.",
      "expense_date must be YYYY-MM-DD or null.",
      "total_cents must be the final amount paid, including tax and discounts.",
      "tax_cents should be the sales tax amount if visible, otherwise null.",
      "payment_method must be one of: cash, credit_card, check, ach, company_card, reimbursable_personal, other, or null.",
      "description should be a short purchase summary, not a full line-item dump.",
      "confidence must be high, medium, or low.",
      "If a value is uncertain, use null and explain briefly in notes.",
    ].join("\n"),
    errorLabel: "receipt",
  })
}

async function generateGeminiExtraction({
  apiKey,
  model,
  mimeType,
  base64,
  prompt,
  errorLabel,
}: {
  apiKey: string
  model: string
  mimeType: string
  base64: string
  prompt: string
  errorLabel: string
}) {
  const normalizedModel = model.startsWith("models/") ? model : `models/${model}`
  const endpoint = process.env.GEMINI_BASE_URL?.replace(/\/$/, "") || "https://generativelanguage.googleapis.com/v1beta"
  const response = await fetch(`${endpoint}/${normalizedModel}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: prompt,
            },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    console.warn(`[ReceiptExtraction] Gemini ${errorLabel} request failed: ${response.status} ${body}`)
    throw new Error(`Could not scan ${errorLabel}`)
  }

  const payload = await response.json()
  const text = extractGeminiResponseText(payload)
  if (!text) throw new Error(`${errorLabel[0]?.toUpperCase() ?? "File"}${errorLabel.slice(1)} scan returned no data`)
  return text
}

function extractGeminiResponseText(payload: any) {
  const parts = payload?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ""
  return parts.map((part) => part?.text).filter((text): text is string => typeof text === "string").join("\n").trim()
}

function parseReceiptJson(rawText: string) {
  const direct = tryParseJson(rawText)
  const directParsed = parseReceiptShape(direct)
  if (directParsed) return directParsed

  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const fencedJson = fenced ? tryParseJson(fenced) : null
  const fencedParsed = parseReceiptShape(fencedJson)
  if (fencedParsed) return fencedParsed

  const firstBrace = rawText.indexOf("{")
  const lastBrace = rawText.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = tryParseJson(rawText.slice(firstBrace, lastBrace + 1))
    const slicedParsed = parseReceiptShape(sliced)
    if (slicedParsed) return slicedParsed
  }

  throw new Error("Could not read receipt details")
}

function parseReceiptShape(value: unknown) {
  if (!value) return null
  const normalized = normalizeReceiptPayload(value)
  const parsed = extractedReceiptSchema.safeParse(normalized)
  if (parsed.success) return parsed.data

  console.warn("[ReceiptExtraction] Could not parse model JSON", {
    issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).slice(0, 6),
    keys: normalized && typeof normalized === "object" ? Object.keys(normalized as Record<string, unknown>).slice(0, 20) : [],
  })
  return null
}

function parsePayableInvoiceJson(rawText: string) {
  const direct = tryParseJson(rawText)
  const directParsed = parsePayableInvoiceShape(direct)
  if (directParsed) return directParsed

  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const fencedJson = fenced ? tryParseJson(fenced) : null
  const fencedParsed = parsePayableInvoiceShape(fencedJson)
  if (fencedParsed) return fencedParsed

  const firstBrace = rawText.indexOf("{")
  const lastBrace = rawText.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = tryParseJson(rawText.slice(firstBrace, lastBrace + 1))
    const slicedParsed = parsePayableInvoiceShape(sliced)
    if (slicedParsed) return slicedParsed
  }

  throw new Error("Could not read invoice details")
}

function parsePayableInvoiceShape(value: unknown) {
  if (!value) return null
  const normalized = normalizePayableInvoicePayload(value)
  const parsed = extractedPayableInvoiceSchema.safeParse(normalized)
  if (parsed.success) return parsed.data

  console.warn("[ReceiptExtraction] Could not parse invoice model JSON", {
    issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).slice(0, 6),
    keys: normalized && typeof normalized === "object" ? Object.keys(normalized as Record<string, unknown>).slice(0, 20) : [],
  })
  return null
}

function normalizeReceiptPayload(value: unknown): Record<string, unknown> | null {
  const record = Array.isArray(value) ? value[0] : value
  if (!record || typeof record !== "object") return null
  const source = record as Record<string, unknown>

  return {
    vendor_name: pickFirst(source, ["vendor_name", "vendorName", "vendor", "merchant", "merchant_name", "store", "store_name", "supplier"]),
    expense_date: pickFirst(source, ["expense_date", "expenseDate", "date", "transaction_date", "transactionDate", "receipt_date", "receiptDate", "purchase_date", "purchaseDate"]),
    total_cents: pickFirst(source, ["total_cents", "totalCents", "total_amount_cents", "totalAmountCents", "total", "total_amount", "totalAmount", "amount", "amount_paid", "amountPaid", "grand_total", "grandTotal"]),
    tax_cents: pickFirst(source, ["tax_cents", "taxCents", "tax_amount_cents", "taxAmountCents", "tax", "tax_amount", "taxAmount", "sales_tax", "salesTax"]),
    payment_method: pickFirst(source, ["payment_method", "paymentMethod", "payment", "tender", "tender_type", "tenderType", "card_type", "cardType"]),
    description: pickFirst(source, ["description", "summary", "memo", "notes", "purchase_summary", "purchaseSummary"]),
    confidence: pickFirst(source, ["confidence", "confidence_level", "confidenceLevel"]),
    notes: pickFirst(source, ["notes", "warnings", "uncertainties", "explanation"]),
  }
}

function normalizePayableInvoicePayload(value: unknown): Record<string, unknown> | null {
  const record = Array.isArray(value) ? value[0] : value
  if (!record || typeof record !== "object") return null
  const source = record as Record<string, unknown>

  return {
    vendor_name: pickFirst(source, ["vendor_name", "vendorName", "vendor", "supplier", "supplier_name", "subcontractor", "company", "company_name"]),
    bill_number: pickFirst(source, ["bill_number", "billNumber", "invoice_number", "invoiceNumber", "invoice_no", "invoiceNo", "doc_number", "docNumber", "reference", "reference_number"]),
    bill_date: pickFirst(source, ["bill_date", "billDate", "invoice_date", "invoiceDate", "date", "issued_date", "issuedDate"]),
    due_date: pickFirst(source, ["due_date", "dueDate", "payment_due_date", "paymentDueDate", "due"]),
    total_cents: pickFirst(source, ["total_cents", "totalCents", "amount_due_cents", "amountDueCents", "total", "total_amount", "totalAmount", "amount_due", "amountDue", "balance_due", "balanceDue"]),
    description: pickFirst(source, ["description", "summary", "memo", "notes", "work_summary", "workSummary", "scope"]),
    confidence: pickFirst(source, ["confidence", "confidence_level", "confidenceLevel"]),
    notes: pickFirst(source, ["notes", "warnings", "uncertainties", "explanation"]),
  }
}

function pickFirst(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== "") return value
  }
  return null
}

function normalizeDateValue(value: unknown) {
  if (typeof value !== "string") return null
  const raw = value.trim()
  if (!raw) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const slashMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (slashMatch) {
    const month = Number(slashMatch[1])
    const day = Number(slashMatch[2])
    const year = Number(slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    }
  }

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

function tryParseJson(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function centsToDollars(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return Math.round(value) / 100
}

function cleanString(value: string | null | undefined) {
  const cleaned = value?.trim()
  return cleaned ? cleaned.slice(0, 500) : null
}
