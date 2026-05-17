import { z } from "zod"

export const paymentMethodInputSchema = z.enum(["ach", "card", "wire", "check"])

export const createPaymentIntentInputSchema = z.object({
  invoice_id: z.string().uuid("Invoice is required"),
  amount_cents: z.number().int().positive().optional(),
  currency: z.string().default("usd"),
  method: paymentMethodInputSchema.optional(),
  include_processing_fee: z.boolean().optional().default(false),
  metadata: z.record(z.any()).optional(),
})

export const createPublicInvoicePaymentIntentInputSchema = z.object({
  token: z.string().min(1, "Invoice link is required"),
  method: z.enum(["ach", "card"]),
})

export const generatePayLinkInputSchema = z.object({
  invoice_id: z.string().uuid("Invoice is required"),
  expires_at: z.string().optional(),
  max_uses: z.number().int().min(1).optional(),
  metadata: z.record(z.any()).optional(),
})

export const recordPaymentInputSchema = z.object({
  invoice_id: z.string().uuid().optional(),
  provider_payment_id: z.string().min(1, "Provider payment id is required"),
  amount_cents: z.number().int().positive("Amount must be positive"),
  fee_cents: z.number().int().min(0).default(0),
  currency: z.string().default("usd"),
  method: paymentMethodInputSchema.optional(),
  status: z.enum(["pending", "processing", "succeeded", "failed", "canceled", "refunded"]).default("succeeded"),
  reference: z.string().optional(),
  provider: z.string().optional(),
  pay_link_token: z.string().optional(),
  idempotency_key: z.string().optional(),
  metadata: z.record(z.any()).optional(),
})

export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentInputSchema>
export type CreatePublicInvoicePaymentIntentInput = z.infer<typeof createPublicInvoicePaymentIntentInputSchema>
export type GeneratePayLinkInput = z.infer<typeof generatePayLinkInputSchema>
export type RecordPaymentInput = z.infer<typeof recordPaymentInputSchema>




