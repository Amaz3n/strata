import type { SupabaseClient } from "@supabase/supabase-js"

export type OnlinePaymentMethod = "ach" | "card"

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

export function normalizePaymentFeePolicy(settings: Record<string, unknown> | null | undefined): PaymentFeePolicy {
  const raw = (settings?.payment_fee_policy ?? settings?.paymentFeePolicy ?? {}) as Record<string, unknown>

  return {
    achEnabled: booleanSetting(raw.ach_enabled ?? raw.achEnabled, DEFAULT_PAYMENT_FEE_POLICY.achEnabled),
    achFeePercent: numberSetting(raw.ach_fee_percent ?? raw.achFeePercent, DEFAULT_PAYMENT_FEE_POLICY.achFeePercent),
    achFeeFixedCents: Math.round(numberSetting(raw.ach_fee_fixed_cents ?? raw.achFeeFixedCents, DEFAULT_PAYMENT_FEE_POLICY.achFeeFixedCents)),
    achFeeCapCents: nullableNumberSetting(raw.ach_fee_cap_cents ?? raw.achFeeCapCents, DEFAULT_PAYMENT_FEE_POLICY.achFeeCapCents),
    cardEnabled: booleanSetting(raw.card_enabled ?? raw.cardEnabled, DEFAULT_PAYMENT_FEE_POLICY.cardEnabled),
    cardFeePercent: numberSetting(raw.card_fee_percent ?? raw.cardFeePercent, DEFAULT_PAYMENT_FEE_POLICY.cardFeePercent),
    cardFeeFixedCents: Math.round(numberSetting(raw.card_fee_fixed_cents ?? raw.cardFeeFixedCents, DEFAULT_PAYMENT_FEE_POLICY.cardFeeFixedCents)),
    cardFeeCapCents: nullableNumberSetting(raw.card_fee_cap_cents ?? raw.cardFeeCapCents, DEFAULT_PAYMENT_FEE_POLICY.cardFeeCapCents),
  }
}

export async function loadPaymentFeePolicy(supabase: SupabaseClient, orgId: string): Promise<PaymentFeePolicy> {
  const { data, error } = await supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle()
  if (error) {
    console.warn("Failed to load payment fee policy; using defaults", error)
  }
  return normalizePaymentFeePolicy((data?.settings as Record<string, unknown> | null) ?? null)
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
  const grossedUpTotal =
    feeRate > 0 && feeRate < 1
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
