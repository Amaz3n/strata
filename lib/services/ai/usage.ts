import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  catalogEntry,
  normalizeModelId,
  type AiFeature,
  type AiProvider,
  type AiTier,
} from "@/lib/services/ai-config"

/**
 * What a model call cost, and where it went.
 *
 * Two rules make this trustworthy:
 *
 * 1. A model we have no published price for reports `null`, never a guess. A
 *    fabricated price is worse than a blank, because it silently under-reports
 *    spend and nobody goes looking.
 * 2. Recording never throws. Telemetry that can fail a payable scan is a
 *    liability, so every failure here is swallowed after a warn.
 */

export interface AiTokenUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export interface AiUsageRecord {
  orgId: string | null
  feature: AiFeature
  tier: AiTier
  provider: AiProvider
  model: string
  usage: AiTokenUsage
  latencyMs: number
  /** Which attempt produced this row, 1-based. Escalations record their own row. */
  attempt: number
  escalatedFrom: AiTier | null
  status: "ok" | "error" | "cache_hit"
  errorKind: string | null
  /**
   * The provider's own message. `errorKind` is the bucket a chart groups by;
   * this is the sentence that actually names the problem — "model no longer
   * available to new users" reads very differently from `provider_error`.
   */
  errorMessage?: string | null
  /** Free-form correlation, e.g. the bill id a scan belongs to. */
  entityType: string | null
  entityId: string | null
}

const PRICE_OVERRIDE_SETTINGS_KEY = "ai_model_prices"
const PRICE_CACHE_TTL_MS = 60_000

type PriceOverride = { inputPerMTokUsd: number | null; outputPerMTokUsd: number | null }

let priceCache: { expiresAt: number; value: Record<string, PriceOverride> } | null = null

function priceKey(provider: AiProvider, model: string) {
  return `${provider}:${normalizeModelId(model)}`
}

function coercePrice(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null
  return value
}

/**
 * Operator-supplied prices, so a model released after this code shipped still
 * reports real spend once someone types its rate on the platform page.
 */
export async function loadPriceOverrides(supabase: SupabaseClient): Promise<Record<string, PriceOverride>> {
  const now = Date.now()
  if (priceCache && priceCache.expiresAt > now) return priceCache.value

  const value: Record<string, PriceOverride> = {}
  try {
    const { data } = await supabase
      .from("platform_settings")
      .select("value")
      .eq("key", PRICE_OVERRIDE_SETTINGS_KEY)
      .maybeSingle()

    const raw = (data as { value?: unknown } | null)?.value
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object") continue
        const record = entry as Record<string, unknown>
        value[key] = {
          inputPerMTokUsd: coercePrice(record.input_per_mtok_usd ?? record.inputPerMTokUsd),
          outputPerMTokUsd: coercePrice(record.output_per_mtok_usd ?? record.outputPerMTokUsd),
        }
      }
    }
  } catch (error) {
    console.warn("[ai/usage] Could not load model price overrides", error)
  }

  priceCache = { expiresAt: now + PRICE_CACHE_TTL_MS, value }
  return value
}

export function invalidateAiPriceCache() {
  priceCache = null
}

/**
 * Cost in USD, or null when the model has no known price. Overrides beat the
 * built-in catalog so an operator can correct a stale rate without a deploy.
 */
export function estimateCostUsd({
  provider,
  model,
  usage,
  overrides,
}: {
  provider: AiProvider
  model: string
  usage: AiTokenUsage
  overrides?: Record<string, PriceOverride>
}): number | null {
  const override = overrides?.[priceKey(provider, model)]
  const catalog = catalogEntry(provider, model)

  const inputRate = override?.inputPerMTokUsd ?? catalog?.inputPerMTokUsd ?? null
  const outputRate = override?.outputPerMTokUsd ?? catalog?.outputPerMTokUsd ?? null
  if (inputRate === null && outputRate === null) return null

  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  if (inputTokens === 0 && outputTokens === 0) return null

  const cost = (inputTokens / 1_000_000) * (inputRate ?? 0) + (outputTokens / 1_000_000) * (outputRate ?? 0)
  // Sub-cent calls are the norm here; keep enough precision to sum a month.
  return Math.round(cost * 1_000_000) / 1_000_000
}

/**
 * Append one row per model attempt. Deliberately fire-and-forget: the caller
 * already has its answer and must not fail because analytics did.
 */
export async function recordAiUsage(supabase: SupabaseClient, record: AiUsageRecord): Promise<void> {
  try {
    const overrides = await loadPriceOverrides(supabase)
    const costUsd = estimateCostUsd({
      provider: record.provider,
      model: record.model,
      usage: record.usage,
      overrides,
    })

    const { error } = await supabase.from("ai_usage_events").insert({
      org_id: record.orgId,
      feature: record.feature,
      tier: record.tier,
      provider: record.provider,
      model: normalizeModelId(record.model),
      input_tokens: record.usage.inputTokens,
      output_tokens: record.usage.outputTokens,
      total_tokens: record.usage.totalTokens,
      cost_usd: costUsd,
      latency_ms: record.latencyMs,
      attempt: record.attempt,
      escalated_from: record.escalatedFrom,
      status: record.status,
      error_kind: record.errorKind,
      // Truncated: provider errors sometimes carry a whole request echo, and
      // this table takes a row per attempt.
      error_message: record.errorMessage ? record.errorMessage.slice(0, 500) : null,
      entity_type: record.entityType,
      entity_id: record.entityId,
    })

    if (error) {
      // A missing table is expected until the migration is approved; say so once
      // rather than screaming on every call.
      if (error.code === "42P01") return
      console.warn("[ai/usage] Could not record AI usage", error.message)
    }
  } catch (error) {
    console.warn("[ai/usage] Could not record AI usage", error)
  }
}
