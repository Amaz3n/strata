import type { SupabaseClient } from "@supabase/supabase-js"

import { assertIntegerCents } from "@/lib/payments/payment-domain"

export type OnlinePaymentMethod = "ach" | "card"
export type FeeKind = "ar_ach" | "ar_card" | "ap_disbursement" | "card_interchange" | "early_pay_spread"

export interface PaymentFeePolicy {
  achEnabled: boolean
  achFeePercent: number
  achFeeFixedCents: number
  achFeeCapCents: number | null
  cardEnabled: boolean
  cardFeePercent: number
  cardFeeFixedCents: number
  cardFeeCapCents: number | null
}

export interface PaymentFeeQuote {
  method: OnlinePaymentMethod
  enabled: boolean
  invoiceBalanceCents: number
  feeCents: number
  totalCents: number
  feePercent: number
  feeFixedCents: number
  feeCapCents: number | null
  label: string
  disclosure: string
}

export interface ApFeePolicy {
  passThroughProcessorFees: boolean
  processorFeeBps?: number
  processorFeeFixedCents?: number
  processorFeeCapCents?: number | null
  platformFeeFlatCents: number
  platformFeeBps: number
}

export interface ApFeeQuote {
  kind: "ap_disbursement"
  payer: "org"
  vendorAmountCents: number
  processorFeeCents: number
  platformFeeCents: number
  totalDebitCents: number
  description: string
}

export const DEFAULT_PAYMENT_FEE_POLICY: PaymentFeePolicy = {
  achEnabled: true,
  achFeePercent: 0.8,
  achFeeFixedCents: 0,
  achFeeCapCents: 500,
  cardEnabled: true,
  cardFeePercent: 2.9,
  cardFeeFixedCents: 30,
  cardFeeCapCents: null,
}

export const DEFAULT_AP_FEE_POLICY: ApFeePolicy = {
  passThroughProcessorFees: true,
  platformFeeFlatCents: 0,
  platformFeeBps: 0,
}

function numberSetting(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function nullableNumberSetting(value: unknown, fallback: number | null) {
  if (value == null) return fallback
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function booleanSetting(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

function objectSetting(value: object, snakeKey: string, camelKey: string) {
  return Reflect.get(value, snakeKey) ?? Reflect.get(value, camelKey)
}

export function normalizePaymentFeePolicy(settings: Record<string, unknown> | null | undefined): PaymentFeePolicy {
  const candidate = settings?.payment_fee_policy ?? settings?.paymentFeePolicy
  const raw = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {}
  return {
    achEnabled: booleanSetting(objectSetting(raw, "ach_enabled", "achEnabled"), DEFAULT_PAYMENT_FEE_POLICY.achEnabled),
    achFeePercent: numberSetting(objectSetting(raw, "ach_fee_percent", "achFeePercent"), DEFAULT_PAYMENT_FEE_POLICY.achFeePercent),
    achFeeFixedCents: Math.round(numberSetting(objectSetting(raw, "ach_fee_fixed_cents", "achFeeFixedCents"), DEFAULT_PAYMENT_FEE_POLICY.achFeeFixedCents)),
    achFeeCapCents: nullableNumberSetting(objectSetting(raw, "ach_fee_cap_cents", "achFeeCapCents"), DEFAULT_PAYMENT_FEE_POLICY.achFeeCapCents),
    cardEnabled: booleanSetting(objectSetting(raw, "card_enabled", "cardEnabled"), DEFAULT_PAYMENT_FEE_POLICY.cardEnabled),
    cardFeePercent: numberSetting(objectSetting(raw, "card_fee_percent", "cardFeePercent"), DEFAULT_PAYMENT_FEE_POLICY.cardFeePercent),
    cardFeeFixedCents: Math.round(numberSetting(objectSetting(raw, "card_fee_fixed_cents", "cardFeeFixedCents"), DEFAULT_PAYMENT_FEE_POLICY.cardFeeFixedCents)),
    cardFeeCapCents: nullableNumberSetting(objectSetting(raw, "card_fee_cap_cents", "cardFeeCapCents"), DEFAULT_PAYMENT_FEE_POLICY.cardFeeCapCents),
  }
}

export async function loadPaymentFeePolicy(supabase: SupabaseClient, orgId: string): Promise<PaymentFeePolicy> {
  const { data, error } = await supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle()
  if (error) console.warn("Failed to load payment fee policy; using defaults", error)
  const settings = data?.settings
  return normalizePaymentFeePolicy(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : null)
}

export function calculatePaymentFeeQuote(params: {
  invoiceBalanceCents: number
  method: OnlinePaymentMethod
  policy?: PaymentFeePolicy
}): PaymentFeeQuote {
  const policy = params.policy ?? DEFAULT_PAYMENT_FEE_POLICY
  const invoiceBalanceCents = Math.max(0, Math.round(params.invoiceBalanceCents))
  const isAch = params.method === "ach"
  const enabled = isAch ? policy.achEnabled : policy.cardEnabled
  const feePercent = isAch ? policy.achFeePercent : policy.cardFeePercent
  const feeFixedCents = isAch ? policy.achFeeFixedCents : policy.cardFeeFixedCents
  const feeCapCents = isAch ? policy.achFeeCapCents : policy.cardFeeCapCents
  const feeRate = feePercent / 100
  const grossedUpTotal = feeRate > 0 && feeRate < 1
    ? Math.ceil((invoiceBalanceCents + feeFixedCents) / (1 - feeRate))
    : invoiceBalanceCents + feeFixedCents
  const uncappedFee = Math.max(0, grossedUpTotal - invoiceBalanceCents)
  const feeCents = enabled ? (feeCapCents == null ? uncappedFee : Math.min(uncappedFee, feeCapCents)) : 0
  return {
    method: params.method,
    enabled,
    invoiceBalanceCents,
    feeCents,
    totalCents: invoiceBalanceCents + feeCents,
    feePercent,
    feeFixedCents,
    feeCapCents,
    label: isAch ? "ACH bank transfer" : "Card",
    disclosure: isAch
      ? "ACH payments include a bank processing fee shown before payment. ACH payments can take several business days to settle."
      : "Card payments include a processing fee shown before payment. You can avoid this card fee by choosing ACH.",
  }
}

export function calculatePaymentFeeQuotes(invoiceBalanceCents: number, policy?: PaymentFeePolicy) {
  return {
    ach: calculatePaymentFeeQuote({ invoiceBalanceCents, method: "ach", policy }),
    card: calculatePaymentFeeQuote({ invoiceBalanceCents, method: "card", policy }),
  }
}

export function quoteApDisbursementFee(input: {
  vendorAmountCents: number
  estimatedProcessorFeeCents?: number
  policy?: ApFeePolicy
}): ApFeeQuote {
  const policy = input.policy ?? DEFAULT_AP_FEE_POLICY
  const vendorAmountCents = assertIntegerCents(input.vendorAmountCents, "Vendor amount")
  const calculatedProcessorFee = Math.round((vendorAmountCents * (policy.processorFeeBps ?? 0)) / 10_000)
    + (policy.processorFeeFixedCents ?? 0)
  const cappedProcessorFee = policy.processorFeeCapCents == null
    ? calculatedProcessorFee
    : Math.min(calculatedProcessorFee, policy.processorFeeCapCents)
  const estimatedProcessorFeeCents = assertIntegerCents(
    input.estimatedProcessorFeeCents ?? cappedProcessorFee,
    "Processor fee",
    { allowZero: true },
  )
  const processorFeeCents = policy.passThroughProcessorFees ? estimatedProcessorFeeCents : 0
  const platformFeeCents = policy.platformFeeFlatCents + Math.round((vendorAmountCents * policy.platformFeeBps) / 10_000)
  assertIntegerCents(platformFeeCents, "Platform fee", { allowZero: true })
  return {
    kind: "ap_disbursement",
    payer: "org",
    vendorAmountCents,
    processorFeeCents,
    platformFeeCents,
    totalDebitCents: vendorAmountCents + processorFeeCents + platformFeeCents,
    description: platformFeeCents > 0
      ? "Provider costs plus Arc payment fee"
      : "Provider processing costs passed through at cost",
  }
}
