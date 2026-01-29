import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"

import type { Invoice, Payment, PaymentIntent, PaymentLink } from "@/lib/types"
import {
  createPaymentIntentInputSchema,
  generatePayLinkInputSchema,
  recordPaymentInputSchema,
  type CreatePaymentIntentInput,
  type GeneratePayLinkInput,
  type RecordPaymentInput,
} from "@/lib/validation/payments"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createStripePaymentIntent } from "@/lib/integrations/payments/stripe"
import { generateConditionalWaiverForPayment } from "@/lib/services/lien-waivers"
import { enqueuePaymentSync } from "@/lib/services/qbo-sync"
import { recalcInvoiceBalanceAndStatus } from "@/lib/services/invoice-balance"

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com"
const PAY_PATH = `${APP_URL}/p/pay`
const LINK_SECRET = process.env.PAYMENT_LINK_SECRET

const reminderRuleSchema = z.object({
  invoice_id: z.string().uuid("Invoice is required"),
  channel: z.enum(["email", "sms"]).default("email"),
  schedule: z.enum(["before_due", "after_due", "overdue"]).default("before_due"),
  offset_days: z.number().int().min(0).default(0),
  template_id: z.string().optional(),
  metadata: z.record(z.any()).optional(),
})

const lateFeeRuleSchema = z.object({
  project_id: z.string().uuid().optional(),
  strategy: z.enum(["fixed", "percent"]).default("fixed"),
  amount_cents: z.number().int().min(0).optional(),
  percent_rate: z.number().min(0).max(100).optional(),
  grace_days: z.number().int().min(0).default(0),
  repeat_days: z.number().int().min(0).optional(),
  max_applications: z.number().int().min(1).optional(),
  metadata: z.record(z.any()).optional(),
})

function mapPayment(row: any): Payment {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? undefined,
    invoice_id: row.invoice_id ?? undefined,
    bill_id: row.bill_id ?? undefined,
    amount_cents: row.amount_cents,
    currency: row.currency ?? "usd",
    method: row.method ?? undefined,
    provider: row.provider ?? undefined,
    provider_payment_id: row.provider_payment_id ?? undefined,
    status: row.status ?? "pending",
    reference: row.reference ?? undefined,
    fee_cents: row.fee_cents ?? undefined,
    net_cents: row.net_cents ?? undefined,
    metadata: row.metadata ?? undefined,
    received_at: row.received_at ?? row.created_at,
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
  }
}

function mapPaymentIntent(row: any): PaymentIntent {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id ?? undefined,
    invoice_id: row.invoice_id ?? undefined,
    provider: row.provider ?? "stripe",
    provider_intent_id: row.provider_intent_id ?? undefined,
    status: row.status ?? "requires_payment_method",
    amount_cents: row.amount_cents,
    currency: row.currency ?? "usd",
    client_secret: row.client_secret ?? undefined,
    idempotency_key: row.idempotency_key ?? undefined,
    expires_at: row.expires_at ?? undefined,
    metadata: row.metadata ?? undefined,
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
  }
}

function mapPaymentLink(row: any): PaymentLink {
  return {
    id: row.id,
    org_id: row.org_id,
    invoice_id: row.invoice_id,
    token_hash: row.token_hash ?? undefined,
    nonce: row.nonce ?? undefined,
    expires_at: row.expires_at ?? undefined,
    max_uses: row.max_uses ?? undefined,
    used_count: row.used_count ?? 0,
    metadata: row.metadata ?? undefined,
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function generateToken() {
  return randomBytes(32).toString("hex")
}

type PayLinkPayload = {
  org_id: string
  project_id: string
  invoice_id: string
  exp: number
  nonce: string
}

function ensureLinkSecret() {
  if (!LINK_SECRET) {
    throw new Error("PAYMENT_LINK_SECRET is not configured")
  }
  return LINK_SECRET
}

export function generateSignedPayLink(params: { orgId: string; projectId: string; invoiceId: string; expiresInHours?: number }) {
  const secret = ensureLinkSecret()
  const nonce = randomBytes(16).toString("hex")
  const exp = Math.floor(Date.now() / 1000) + (params.expiresInHours ?? 72) * 3600

  const payload: PayLinkPayload = {
    org_id: params.orgId,
    project_id: params.projectId,
    invoice_id: params.invoiceId,
    exp,
    nonce,
  }

  const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", secret).update(payloadStr).digest("base64url")
  const token = `${payloadStr}.${signature}`
  const url = `${PAY_PATH}/${token}`
  return { url, token }
}

export function validateSignedPayLink(token: string): PayLinkPayload | null {
  if (!token.includes(".")) return null
  const secret = LINK_SECRET
  if (!secret) return null

  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [payloadStr, signature] = parts

  const expectedSig = createHmac("sha256", secret).update(payloadStr).digest("base64url")
  try {
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return null
    }
  } catch {
    return null
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadStr, "base64url").toString()) as PayLinkPayload
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

async function rotatePayLinkNonce(invoiceId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data: link } = await supabase
    .from("payment_links")
    .select("id, used_count")
    .eq("invoice_id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (!link) return
  const nextUsed = (link.used_count ?? 0) + 1
  const newNonce = randomBytes(16).toString("hex")
  await supabase.from("payment_links").update({ nonce: newNonce, used_count: nextUsed }).eq("id", link.id)
}

async function getInvoiceTotals(supabase: ReturnType<typeof createServiceSupabaseClient>, invoiceId: string, orgId: string) {
  const { data, error } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, invoice_number, total_cents, balance_due_cents, due_date, status, metadata")
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (error || !data) {
    throw new Error("Invoice not found or inaccessible")
  }

  return data
}

async function ensureReceiptForPayment({
  supabase,
  orgId,
  invoice,
  paymentId,
  amountCents,
  provider,
  method,
  reference,
}: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  invoice: any
  paymentId: string
  amountCents: number
  provider?: string | null
  method?: string | null
  reference?: string | null
}) {
  try {
    const issuedToEmail =
      (invoice?.metadata as any)?.customer_email ??
      (invoice?.metadata as any)?.customerEmail ??
      (invoice?.metadata as any)?.email ??
      null

    await supabase.from("receipts").upsert(
      {
        org_id: orgId,
        project_id: invoice.project_id ?? null,
        invoice_id: invoice.id,
        payment_id: paymentId,
        amount_cents: amountCents,
        issued_to_email: issuedToEmail,
        issued_at: new Date().toISOString(),
        metadata: {
          invoice_number: invoice.invoice_number ?? null,
          provider: provider ?? null,
          method: method ?? null,
          reference: reference ?? null,
        },
      },
      { onConflict: "payment_id" },
    )
  } catch (err) {
    console.warn("Failed to create receipt for payment", err)
  }
}

export async function generatePayLink(input: GeneratePayLinkInput, orgId?: string) {
  const parsed = generatePayLinkInputSchema.parse(input)
  const { orgId: resolvedOrgId, supabase } = await requireOrgContext(orgId)

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, org_id, project_id")
    .eq("id", parsed.invoice_id)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (invoiceError || !invoice) {
    throw new Error("Invoice not found for pay link generation")
  }

  // Prefer signed HMAC link when secret is configured; fall back to hashed token if not.
  if (LINK_SECRET) {
    const { url, token } = generateSignedPayLink({
      orgId: resolvedOrgId,
      projectId: invoice.project_id,
      invoiceId: parsed.invoice_id,
      expiresInHours: parsed.expires_at ? Math.max(1, Math.floor((new Date(parsed.expires_at).getTime() - Date.now()) / 3600000)) : 72,
    })
    return { url, token }
  }

  const token = generateToken()
  const token_hash = hashToken(token)
  const nonce = generateToken()

  const payload = {
    org_id: resolvedOrgId,
    invoice_id: parsed.invoice_id,
    token_hash,
    nonce,
    expires_at: parsed.expires_at ?? null,
    max_uses: parsed.max_uses ?? null,
    metadata: parsed.metadata ?? {},
  }

  const { data: linkRow, error: linkError } = await supabase
    .from("payment_links")
    .insert(payload)
    .select("*")
    .single()

  if (linkError || !linkRow) {
    throw new Error(`Failed to create payment link: ${linkError?.message}`)
  }

  const url = `${PAY_PATH}/${token}`
  return { url, token, link: mapPaymentLink(linkRow) }
}

export async function validatePayLinkToken(token: string) {
  // If token is HMAC-signed, validate without DB lookup.
  const signedPayload = validateSignedPayLink(token)
  if (signedPayload) {
    return {
      link: { id: "", org_id: signedPayload.org_id, invoice_id: signedPayload.invoice_id } as PaymentLink,
      invoice: {
        id: signedPayload.invoice_id,
        org_id: signedPayload.org_id,
        project_id: signedPayload.project_id,
      } as Invoice,
      signed: true as const,
    }
  }

  const token_hash = hashToken(token)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("payment_links")
    .select("*, invoice:invoices(id, org_id, project_id, invoice_number, title, status, due_date, total_cents, balance_due_cents, metadata)")
    .eq("token_hash", token_hash)
    .maybeSingle()

  if (error || !data) return null
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null
  if (data.max_uses != null && data.used_count != null && data.used_count >= data.max_uses) return null

  return {
    link: mapPaymentLink(data),
    invoice: data.invoice as Invoice,
  }
}

export async function getInvoiceForPayLink(token: string) {
  const result = await validatePayLinkToken(token)
  if (!result) return null

  // Signed token already carries invoice ids; for hashed tokens fetch full invoice.
  if ("signed" in result && result.signed) {
    return { link: result.link, invoice: result.invoice }
  }

  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at, invoice_lines (id, description, quantity, unit, unit_price_cents, metadata)",
    )
    .eq("id", result.invoice.id)
    .eq("org_id", result.invoice.org_id)
    .maybeSingle()

  if (error || !data) return null

  return {
    link: result.link,
    invoice: {
      ...result.invoice,
      metadata: data.metadata ?? result.invoice.metadata,
      lines: (data as any).invoice_lines ?? [],
    },
  }
}

export async function createPaymentIntent(input: CreatePaymentIntentInput, orgId?: string) {
  const parsed = createPaymentIntentInputSchema.parse(input)
  const { orgId: resolvedOrgId, supabase } = await requireOrgContext(orgId)

  const invoice = await getInvoiceTotals(supabase, parsed.invoice_id, resolvedOrgId)
  const amount = parsed.amount_cents ?? invoice.balance_due_cents ?? invoice.total_cents ?? 0
  if (amount <= 0) throw new Error("Invoice has no outstanding balance")

  const stripeIntent = await createStripePaymentIntent({
    amount_cents: amount,
    currency: parsed.currency ?? "usd",
    invoice_id: parsed.invoice_id,
    org_id: resolvedOrgId,
    project_id: invoice.project_id,
    description: `Invoice ${parsed.invoice_id}`,
    metadata: parsed.metadata
      ? Object.fromEntries(Object.entries(parsed.metadata).map(([key, value]) => [key, String(value)]))
      : undefined,
  })

  const intentPayload = {
    org_id: resolvedOrgId,
    project_id: invoice.project_id,
    invoice_id: parsed.invoice_id,
    provider: "stripe",
    amount_cents: amount,
    currency: parsed.currency ?? "usd",
    status: stripeIntent.status,
    client_secret: stripeIntent.client_secret,
    provider_intent_id: stripeIntent.provider_intent_id,
    idempotency_key: stripeIntent.provider_intent_id,
    metadata: parsed.metadata ?? {},
  }

  const { data, error } = await supabase.from("payment_intents").insert(intentPayload).select("*").single()

  if (error || !data) {
    throw new Error(`Failed to create payment intent: ${error?.message}`)
  }

  return mapPaymentIntent(data)
}

export async function recordPayment(input: RecordPaymentInput, orgId?: string) {
  const parsed = recordPaymentInputSchema.parse(input)
  const supabase = createServiceSupabaseClient()

  let resolvedOrgId = orgId
  let invoiceId = parsed.invoice_id
  let paymentLinkId: string | undefined

  if (parsed.pay_link_token) {
    const validation = await validatePayLinkToken(parsed.pay_link_token)
    if (!validation) throw new Error("Payment link is invalid or expired")
    resolvedOrgId = validation.invoice.org_id
    invoiceId = validation.invoice.id
    paymentLinkId = validation.link.id
  }

  if (!resolvedOrgId || !invoiceId) {
    const ctx = await requireOrgContext(orgId)
    resolvedOrgId = ctx.orgId
    invoiceId = invoiceId ?? parsed.invoice_id ?? undefined
  }

  if (!resolvedOrgId || !invoiceId) {
    throw new Error("Missing org or invoice for payment")
  }

  const invoice = await getInvoiceTotals(supabase, invoiceId, resolvedOrgId)

  if (parsed.provider_payment_id) {
    const { data: existing } = await supabase
      .from("payments")
      .select("*")
      .eq("org_id", resolvedOrgId)
      .eq("provider_payment_id", parsed.provider_payment_id)
      .maybeSingle()

    if (existing) return mapPayment(existing)
  }

  const payload = {
    org_id: resolvedOrgId,
    project_id: invoice.project_id,
    invoice_id: invoiceId,
    amount_cents: parsed.amount_cents,
    currency: parsed.currency ?? "usd",
    method: parsed.method ?? "ach",
    provider: parsed.provider ?? "stripe",
    provider_payment_id: parsed.provider_payment_id,
    status: parsed.status ?? "succeeded",
    reference: parsed.reference ?? null,
    fee_cents: parsed.fee_cents ?? 0,
    net_cents: parsed.amount_cents - (parsed.fee_cents ?? 0),
    metadata: parsed.metadata ?? {},
    idempotency_key: parsed.idempotency_key ?? null,
  }

  const { data: paymentRow, error: paymentError } = await supabase.from("payments").insert(payload).select("*").single()

  if (paymentError || !paymentRow) {
    throw new Error(`Failed to record payment: ${paymentError?.message}`)
  }

  await recalcInvoiceBalanceAndStatus({ supabase, orgId: resolvedOrgId, invoiceId })

  if (payload.status === "succeeded" && payload.invoice_id) {
    await ensureReceiptForPayment({
      supabase,
      orgId: resolvedOrgId,
      invoice,
      paymentId: paymentRow.id,
      amountCents: payload.amount_cents,
      provider: payload.provider,
      method: payload.method,
      reference: payload.reference,
    })
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: undefined,
    action: "insert",
    entityType: "payment",
    entityId: paymentRow.id,
    after: payload,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "payment_recorded",
    entityType: "payment",
    entityId: paymentRow.id,
    payload: { invoice_id: invoiceId, amount_cents: parsed.amount_cents, status: parsed.status },
  })

  // Auto-generate conditional lien waiver for this payment (best-effort).
  try {
    await generateConditionalWaiverForPayment(paymentRow.id, resolvedOrgId)
  } catch (waiverError) {
    console.error("Failed to generate lien waiver", waiverError)
  }

  if (paymentLinkId) {
    const { data: linkRow } = await supabase
      .from("payment_links")
      .select("used_count, max_uses")
      .eq("id", paymentLinkId)
      .maybeSingle()

    if (linkRow) {
      const nextUsed = (linkRow.used_count ?? 0) + 1
      await supabase.from("payment_links").update({ used_count: nextUsed }).eq("id", paymentLinkId)
    }
  } else if (parsed.pay_link_token) {
    // HMAC-signed link path: rotate nonce to prevent replay when possible.
    await rotatePayLinkNonce(invoiceId, resolvedOrgId)
  }

  try {
    await enqueuePaymentSync(paymentRow.id, resolvedOrgId)
  } catch (err) {
    console.error("Failed to enqueue QBO payment sync", err)
  }

  return mapPayment(paymentRow)
}

export async function listPaymentsForInvoice(invoiceId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("payments")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("invoice_id", invoiceId)
    .order("received_at", { ascending: false })

  if (error) throw new Error(`Failed to list payments: ${error.message}`)
  return (data ?? []).map(mapPayment)
}

export async function upsertReminderRule(input: unknown, orgId?: string) {
  const parsed = reminderRuleSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, org_id")
    .eq("id", parsed.invoice_id)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (invoiceError || !invoice) {
    throw new Error("Invoice not found for reminder rule")
  }

  const { data, error } = await supabase
    .from("reminders")
    .insert({
      org_id: resolvedOrgId,
      invoice_id: parsed.invoice_id,
      channel: parsed.channel,
      schedule: parsed.schedule,
      offset_days: parsed.offset_days,
      template_id: parsed.template_id ?? null,
      metadata: parsed.metadata ?? {},
    })
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create reminder rule: ${error?.message}`)
  }

  return data
}

export async function upsertLateFeeRule(input: unknown, orgId?: string) {
  const parsed = lateFeeRuleSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("late_fees")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id ?? null,
      strategy: parsed.strategy,
      amount_cents: parsed.amount_cents ?? null,
      percent_rate: parsed.percent_rate ?? null,
      grace_days: parsed.grace_days ?? 0,
      repeat_days: parsed.repeat_days ?? null,
      max_applications: parsed.max_applications ?? null,
      metadata: parsed.metadata ?? {},
    })
    .select("*")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create late fee rule: ${error?.message}`)
  }

  return data
}

export async function findDueReminders() {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("reminders")
    .select(
      "id, org_id, invoice:invoices(id, org_id, due_date, status, balance_due_cents, invoice_number, project_id), channel, schedule, offset_days, template_id, metadata",
    )

  if (error) {
    throw new Error(`Failed to load reminders: ${error.message}`)
  }

  const now = new Date()
  const due = (data ?? []).filter((row) => {
    const invoice = Array.isArray(row.invoice) ? row.invoice[0] : row.invoice
    const dueDate = invoice?.due_date ? new Date(invoice.due_date) : undefined
    if (!dueDate) return false
    const diffDays = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    const overdueDays = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))

    if (row.schedule === "before_due") {
      return diffDays <= row.offset_days && diffDays >= 0
    }
    if (row.schedule === "after_due" || row.schedule === "overdue") {
      return overdueDays >= row.offset_days && (invoice?.balance_due_cents ?? 0) > 0
    }
    return false
  })

  return due
}

export async function findLateFeeCandidates() {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("late_fees")
    .select("id, org_id, project_id, strategy, amount_cents, percent_rate, grace_days, repeat_days, max_applications, metadata")

  if (error) {
    throw new Error(`Failed to load late fee rules: ${error.message}`)
  }

  return data ?? []
}
