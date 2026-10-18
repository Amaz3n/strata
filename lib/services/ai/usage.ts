import "server-only"

import { redactAiError } from "@/lib/services/ai/policy"
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
  cachedInputTokens?: number | null
  cacheWriteTokens?: number | null
  reasoningTokens?: number | null
  audioSeconds?: number | null
  upstreamProvider?: string | null
}

export function toTokenUsage(usage?: {
  inputTokens?: number; outputTokens?: number; totalTokens?: number
  cachedInputTokens?: number; reasoningTokens?: number
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
  outputTokenDetails?: { reasoningTokens?: number }
} | null, metadata?: unknown): AiTokenUsage {
  return {
    upstreamProvider: typeof (metadata as { openrouter?: { upstreamProvider?: unknown } })?.openrouter?.upstreamProvider === "string"
      ? (metadata as { openrouter: { upstreamProvider: string } }).openrouter.upstreamProvider : null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens ?? null,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? null,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? usage?.reasoningTokens ?? null,
  }
}

/** Validation failures can still carry billable completion usage. */
export function usageFromError(error: unknown): AiTokenUsage {
  const value = error as { usage?: Parameters<typeof toTokenUsage>[0] }
  return toTokenUsage(value?.usage)
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

type PriceOverride = { inputPerMTokUsd: number | null; outputPerMTokUsd: number | null; cachedInputPerMTokUsd?: number | null; cacheWritePerMTokUsd?: number | null }

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
          cachedInputPerMTokUsd: coercePrice(record.cached_input_per_mtok_usd ?? record.cachedInputPerMTokUsd),
          cacheWritePerMTokUsd: coercePrice(record.cache_write_per_mtok_usd ?? record.cacheWritePerMTokUsd),
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

  if (usage.audioSeconds != null && catalog?.audioPerMinuteUsd != null) {
    return Math.round(usage.audioSeconds / 60 * catalog.audioPerMinuteUsd * 1_000_000) / 1_000_000
  }
  // Unknown usage is not zero usage; failures may still have incurred charges.
  if (usage.inputTokens == null || usage.outputTokens == null) return null
  if (usage.inputTokens === 0 && usage.outputTokens === 0) return 0
  let inputRate = override?.inputPerMTokUsd ?? catalog?.inputPerMTokUsd ?? null
  let outputRate = override?.outputPerMTokUsd ?? catalog?.outputPerMTokUsd ?? null
  let cachedRate = override?.cachedInputPerMTokUsd ?? catalog?.cachedInputPerMTokUsd ?? inputRate
  let writeRate = override?.cacheWritePerMTokUsd ?? catalog?.cacheWritePerMTokUsd ?? inputRate
  if ((usage.inputTokens > 0 && inputRate == null) || (usage.outputTokens > 0 && outputRate == null)) return null
  // Published Flash promotion expiry, not a forever-discounted catalog estimate.
  if (!override && provider === "google" && /^gemini-3\.[678]-flash$/.test(model) && Date.now() >= Date.parse("2027-01-01T00:00:00Z")) {
    inputRate = (inputRate ?? 0) * 2; outputRate = (outputRate ?? 0) * 2
    cachedRate = cachedRate == null ? null : cachedRate * 2
  }
  if (provider === "openai" && /^gpt-6-/.test(model) && usage.inputTokens > 272_000) {
    inputRate = (inputRate ?? 0) * 2; outputRate = (outputRate ?? 0) * 1.5
    cachedRate = cachedRate == null ? null : cachedRate * 2
    writeRate = writeRate == null ? null : writeRate * 2
  }
  const cached = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens ?? 0))
  const written = Math.min(usage.inputTokens - cached, Math.max(0, usage.cacheWriteTokens ?? 0))
  // Output already includes reasoning. Recording it separately must not double bill it.
  const cost = ((usage.inputTokens - cached - written) * (inputRate ?? 0)
    + cached * (cachedRate ?? 0) + written * (writeRate ?? 0)
    + usage.outputTokens * (outputRate ?? 0)) / 1_000_000
  return Math.round(cost * 1_000_000) / 1_000_000
}

/**
 * Append one row per model attempt. Callers await the write before returning,
 * so serverless teardown does not discard it. Analytics failures never throw.
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
      usage_details: {
        cached_input_tokens: record.usage.cachedInputTokens ?? null,
        cache_write_tokens: record.usage.cacheWriteTokens ?? null,
        reasoning_tokens: record.usage.reasoningTokens ?? null,
        audio_seconds: record.usage.audioSeconds ?? null,
        upstream_provider: record.usage.upstreamProvider ?? null,
        cost_basis: record.usage.audioSeconds != null ? "estimated_audio" : "estimated_tokens",
      },
      cost_usd: costUsd,
      latency_ms: record.latencyMs,
      attempt: record.attempt,
      escalated_from: record.escalatedFrom,
      status: record.status,
      error_kind: record.errorKind,
      // Truncated: provider errors sometimes carry a whole request echo, and
      // this table takes a row per attempt.
      error_message: record.errorMessage ? redactAiError(record.errorMessage) : null,
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

/** Preserve completed tool-step usage if a subsequent step fails. */
export function addTokenUsage(left: AiTokenUsage | null, right: AiTokenUsage): AiTokenUsage {
  if (!left) return right
  const sum = (a: number | null | undefined, b: number | null | undefined) => a == null && b == null ? null : (a ?? 0) + (b ?? 0)
  return {
    inputTokens: sum(left.inputTokens, right.inputTokens), outputTokens: sum(left.outputTokens, right.outputTokens),
    totalTokens: sum(left.totalTokens, right.totalTokens), cachedInputTokens: sum(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteTokens: sum(left.cacheWriteTokens, right.cacheWriteTokens), reasoningTokens: sum(left.reasoningTokens, right.reasoningTokens),
    upstreamProvider: right.upstreamProvider ?? left.upstreamProvider,
  }
}
