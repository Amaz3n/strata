import type { SupabaseClient } from "@supabase/supabase-js"

import type { OrgServiceContext } from "@/lib/services/context"

/**
 * The single source of truth for which model runs which AI feature.
 *
 * Three ideas hold this together:
 *
 * 1. PROVIDERS are native where the hot paths need native behaviour (Google for
 *    document and drawing vision, OpenAI for transcription) and OpenRouter for
 *    everything else. OpenRouter is one key over hundreds of models, so trying
 *    Qwen or a newer Gemini is a config change, never a deploy.
 * 2. TIERS let a feature ask for the cheap model by default and escalate only
 *    when the work earns it. `fast` handles the common case, `standard` is the
 *    workhorse, `heavy` is what a failed verification escalates to.
 * 3. RESOLUTION is layered: platform -> env -> built-in default. The platform
 *    page writes the platform layer, so an operator can point a feature at a
 *    model this file has never heard of. There is no org layer in this path —
 *    `getOrgAiSearchConfig` below is a legacy per-org override for the `search`
 *    feature only, read by the assistant harness and never by the gateway.
 *
 * Model IDs here are seeds, not a closed set. Anything the provider accepts is
 * valid; the catalog exists to make the common choices one click away.
 */

export const AI_PROVIDER_VALUES = ["google", "openai", "openrouter"] as const
export type AiProvider = (typeof AI_PROVIDER_VALUES)[number]

export const AI_FEATURE_VALUES = [
  "search",
  "embedding",
  "document_extraction",
  "drawings_vision",
  "spec_classification",
  "transcription",
  "meeting_minutes",
] as const
export type AiFeature = (typeof AI_FEATURE_VALUES)[number]

/**
 * Cost/capability tier. A caller asks for the tier the work deserves; the
 * escalation ladder in the gateway moves up a tier when a deterministic check
 * fails, so frontier prices are only paid for documents that actually need them.
 */
export const AI_TIER_VALUES = ["fast", "standard", "heavy"] as const
export type AiTier = (typeof AI_TIER_VALUES)[number]

export const AI_TIER_LABELS: Record<AiTier, string> = {
  fast: "Fast",
  standard: "Standard",
  heavy: "Heavy",
}

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  google: "Google",
  openai: "OpenAI",
  openrouter: "OpenRouter",
}

export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
  search: "Search & assistant",
  embedding: "Search embeddings",
  document_extraction: "Document extraction",
  drawings_vision: "Drawings vision",
  spec_classification: "Spec classification",
  transcription: "Transcription",
  meeting_minutes: "Meeting minutes",
}

/** One line on what the feature actually does, for the operator picking its model. */
export const AI_FEATURE_DESCRIPTIONS: Record<AiFeature, string> = {
  search: "Global search answers and the in-app assistant.",
  embedding:
    "Semantic search vectors. The model MUST return 1536 dimensions — the stored column is fixed at that width, and a model of any other size is rejected rather than written.",
  document_extraction: "Invoices, receipts and payables read straight off the page.",
  drawings_vision: "Sheet interpretation, symbol matching and takeoff assistance.",
  spec_classification: "Filing specs and submittals into the right section.",
  transcription: "Voice notes and meeting audio turned into text.",
  meeting_minutes: "Summaries and action items from a transcript.",
}

/** Features that send images or PDFs, so a text-only model cannot serve them. */
export const AI_FEATURE_REQUIRES_VISION: Record<AiFeature, boolean> = {
  search: false,
  embedding: false,
  document_extraction: true,
  drawings_vision: true,
  spec_classification: false,
  transcription: false,
  meeting_minutes: false,
}

export const AI_TIER_HINTS: Record<AiTier, string> = {
  fast: "The common case. A one-page receipt should never cost more than this.",
  standard: "The workhorse, and the first rung escalation reaches for.",
  heavy: "Last resort, only when verification keeps failing.",
}

export type AiConfigSource = "org" | "platform" | "env" | "default"
export type AiDefaultConfigSource = Exclude<AiConfigSource, "org">

export interface AiSearchConfig {
  provider: AiProvider
  model: string
  source: AiConfigSource
}

export interface AiSearchDefaultConfig {
  provider: AiProvider
  model: string
  source: AiDefaultConfigSource
}

export type AiFeatureDefaultConfig = AiSearchDefaultConfig & {
  feature: AiFeature
}

export type AiFeatureTierConfig = AiFeatureDefaultConfig & {
  tier: AiTier
}

const PLATFORM_AI_SETTINGS_KEY = "ai_search_defaults"
const PLATFORM_CONFIG_CACHE_TTL_MS = 60_000

let platformConfigCache: {
  expiresAt: number
  value: Record<string, unknown> | null
} | null = null

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface AiModelCatalogEntry {
  provider: AiProvider
  model: string
  label: string
  /** USD per 1M input tokens. Null when we do not have a published price. */
  inputPerMTokUsd: number | null
  /** USD per 1M output tokens. Null when we do not have a published price. */
  outputPerMTokUsd: number | null
  /** Accepts image/PDF parts — required for extraction and drawings features. */
  vision: boolean
  tier: AiTier
}

/**
 * Seed catalog. Deliberately small: these are the models Arc has actually run,
 * plus the obvious step up on each provider. Operators add anything else from
 * the platform page, and an unknown model is a first-class citizen — it simply
 * reports `null` cost until a price is recorded for it. We never invent a price.
 *
 * Rates verified against provider documentation 23 Aug 2026. Two of them expire:
 * see the promo note on the 3.6/3.7 Flash rows.
 */
export const AI_MODEL_CATALOG: AiModelCatalogEntry[] = [
  // Google — native provider, strongest on drawing and dense-image work.
  //
  // Google's list is NOT monotonic by version. `gemini-3.5-flash` costs double
  // what the newer `gemini-3.6-flash` costs on both input and output, so there
  // is no workload where 3.5 Flash is the right pick. It stays listed only so
  // historical `ai_usage_events` rows can still be priced.
  { provider: "google", model: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", inputPerMTokUsd: 0.1, outputPerMTokUsd: 0.4, vision: true, tier: "fast" },
  { provider: "google", model: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", inputPerMTokUsd: 0.25, outputPerMTokUsd: 1.5, vision: true, tier: "fast" },
  { provider: "google", model: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", inputPerMTokUsd: 0.3, outputPerMTokUsd: 2.5, vision: true, tier: "fast" },
  // PROMO: 3.6 and 3.7 Flash are $0.75/$3.75 through 31 Dec 2026, then revert to
  // $1.50/$7.50 — at which point they cost the same as 3.5 Flash and this whole
  // routing matrix is worth re-running. Diary it. 3.7 is the default of the two:
  // same price, newer, and ~370 t/s against 3.6's ~210.
  { provider: "google", model: "gemini-3.6-flash", label: "Gemini 3.6 Flash", inputPerMTokUsd: 0.75, outputPerMTokUsd: 3.75, vision: true, tier: "standard" },
  { provider: "google", model: "gemini-3.7-flash", label: "Gemini 3.7 Flash", inputPerMTokUsd: 0.75, outputPerMTokUsd: 3.75, vision: true, tier: "standard" },
  { provider: "google", model: "gemini-3.5-flash", label: "Gemini 3.5 Flash (costs 2x 3.6)", inputPerMTokUsd: 1.5, outputPerMTokUsd: 9, vision: true, tier: "standard" },
  // Retained for orgs whose key predates the cutoff — `gemini-2.5-flash` is
  // closed to new API keys ("no longer available to new users"), and the Pro
  // models need paid quota. Selectable, but no longer a default.
  { provider: "google", model: "gemini-2.5-flash", label: "Gemini 2.5 Flash (legacy keys)", inputPerMTokUsd: 0.3, outputPerMTokUsd: 2.5, vision: true, tier: "standard" },
  { provider: "google", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro (paid quota)", inputPerMTokUsd: 1.25, outputPerMTokUsd: 10, vision: true, tier: "heavy" },

  // OpenAI — native provider; owns transcription, and is the first rung of any
  // feature whose output is a schema. `generateObject` on this provider sends a
  // strict `json_schema` response format that constrains DECODING, including
  // `pattern` and `format`. The Google adapter forwards a smaller subset of
  // JSON Schema (no `pattern`, `minimum`, `additionalProperties`), so a Zod
  // constraint outside that subset only ever fires client-side as a rejected
  // object. Model-facing schemas therefore avoid those keywords entirely.
  { provider: "openai", model: "gpt-5-nano", label: "GPT-5 nano", inputPerMTokUsd: 0.05, outputPerMTokUsd: 0.4, vision: true, tier: "fast" },
  { provider: "openai", model: "gpt-5.6-luna", label: "GPT-5.6 Luna", inputPerMTokUsd: 0.2, outputPerMTokUsd: 1.2, vision: true, tier: "fast" },
  { provider: "openai", model: "gpt-5-mini", label: "GPT-5 mini", inputPerMTokUsd: 0.25, outputPerMTokUsd: 2, vision: true, tier: "standard" },
  { provider: "openai", model: "gpt-5.6-terra", label: "GPT-5.6 Terra", inputPerMTokUsd: 2, outputPerMTokUsd: 12, vision: true, tier: "heavy" },
  // PROMO: Sol's $4/$20 runs through 21 Nov 2026; the post-promo rate is not
  // published. Selectable, not a default — Terra is the heavy rung.
  { provider: "openai", model: "gpt-5.6-sol", label: "GPT-5.6 Sol (promo to 21 Nov 2026)", inputPerMTokUsd: 4, outputPerMTokUsd: 20, vision: true, tier: "heavy" },
  // Transcription bills per MINUTE of audio, not per token, so a token-based
  // estimate would be fiction. These rows carry latency and status; their cost
  // reads "unpriced" until someone records a rate they actually want summed.
  // For reference: gpt-4o-mini-transcribe $0.003/min, gpt-transcribe $0.0045/min.
  { provider: "openai", model: "gpt-4o-mini-transcribe", label: "GPT-4o mini Transcribe", inputPerMTokUsd: null, outputPerMTokUsd: null, vision: false, tier: "fast" },
  { provider: "openai", model: "gpt-transcribe", label: "GPT Transcribe", inputPerMTokUsd: null, outputPerMTokUsd: null, vision: false, tier: "standard" },

  // Embeddings. Output tokens are always zero, so only the input rate is real.
  // `text-embedding-3-small` is the only entry at the 1536 dimensions the
  // `search_embeddings` column is declared with; `-large` returns 3072 and is
  // listed for price lookups on historical rows, not as a usable choice.
  { provider: "openai", model: "text-embedding-3-small", label: "Text Embedding 3 Small", inputPerMTokUsd: 0.02, outputPerMTokUsd: 0, vision: false, tier: "fast" },
  { provider: "openai", model: "text-embedding-3-large", label: "Text Embedding 3 Large (3072-dim)", inputPerMTokUsd: 0.13, outputPerMTokUsd: 0, vision: false, tier: "standard" },
]

export function catalogEntry(provider: AiProvider, model: string): AiModelCatalogEntry | null {
  const normalized = normalizeModelId(model)
  return (
    AI_MODEL_CATALOG.find((entry) => entry.provider === provider && entry.model === normalized) ?? null
  )
}

/** Strip the `models/` prefix Gemini tolerates so catalog lookups are stable. */
export function normalizeModelId(model: string) {
  return model.trim().replace(/^models\//, "")
}

/**
 * Can this model be handed a PDF as-is, or does the PDF have to become images?
 *
 * Gemini and OpenAI both accept a PDF file part and page through it themselves.
 * OpenRouter is reached through the openai-compatible provider, which has no
 * file-plugin support: a PDF part there is either ignored or rejected depending
 * on the upstream model, which reads as "extraction quietly got worse" rather
 * than as an error. Everything on OpenRouter is therefore rasterised.
 *
 * Deliberately keyed on the PROVIDER, not the model. A per-model allowlist would
 * have to be maintained against hundreds of OpenRouter entries and would be
 * wrong the week a model changed its input handling; rasterising is never wrong,
 * only slightly more expensive.
 */
export function supportsPdfInput(provider: AiProvider): boolean {
  return provider === "google" || provider === "openai"
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Per feature, per tier. `document_extraction` is the one that matters most:
 * a single-page receipt is a `fast` job, a dense multi-page invoice escalates to
 * `standard`, and only a document that fails deterministic verification twice
 * reaches `heavy`.
 *
 * WHY THE LADDER CROSSES PROVIDERS. It used to be Gemini on all three rungs,
 * and production showed why that is not an escalation ladder: of the first 102
 * logged extraction calls only 22 succeeded, and 55 of the 80 failures were the
 * same `no_object_generated` on every rung. The root cause was a `.regex()` on
 * the date fields that the Google adapter never forwards (see the catalog
 * note) — fixed in the schemas — but the lesson stands: a fault that is
 * provider-shaped cannot be escalated around by climbing further into the same
 * provider. Every rung just fails again, more expensively.
 *
 * So the rungs alternate vendors. Any feature whose output is a schema starts
 * on OpenAI, where `generateObject` constrains decoding, and escalates into
 * Gemini or a larger OpenAI model. Features whose difficulty is visual rather
 * than structural (`drawings_vision`) stay on Gemini, which reads dense sheets
 * better. Where a user is waiting on a long answer (`meeting_minutes`), the
 * rung they hit is the fastest model, not the cheapest.
 *
 * An operator can still point any rung anywhere from the AI console's routing
 * matrix; that is what the per-tier override is for, and it is the right place
 * for a choice that depends on someone's billing plan rather than on Arc.
 */
export const AI_FEATURE_TIER_DEFAULTS: Record<AiFeature, Record<AiTier, { provider: AiProvider; model: string }>> = {
  // Assistant chat streams tool calls under a 10 s per-step budget, so time to
  // first token is the felt metric. The base tier is `standard`, which is the
  // rung users actually hit; 3.7 Flash is the same price as 3.6 and nearly
  // twice as fast. Heavy crosses to OpenAI for tool-calling depth — the
  // harness never escalates on its own, so it is reachable only by override.
  search: {
    fast: { provider: "google", model: "gemini-3.1-flash-lite" },
    standard: { provider: "google", model: "gemini-3.7-flash" },
    heavy: { provider: "openai", model: "gpt-5.6-terra" },
  },
  // Every tier is the same model on purpose. Embeddings have nothing to
  // escalate TO: the vector column is fixed at 1536 dimensions, so a "better"
  // model is not a drop-in, and nothing calls the escalation ladder for this
  // feature. The three rows exist because the routing matrix is per-tier.
  embedding: {
    fast: { provider: "openai", model: "text-embedding-3-small" },
    standard: { provider: "openai", model: "text-embedding-3-small" },
    heavy: { provider: "openai", model: "text-embedding-3-small" },
  },
  // The workload that pays for this file. Starts on OpenAI because strict
  // decoding holds the nested provenance schema exactly, with native PDF input
  // at the cheapest credible rate. Standard crosses to Gemini (fastest reader at
  // the price, and native PDF text is not billed). Heavy is Terra, not Sol:
  // this rung fires only after both cheaper rungs failed arithmetic verify, Sol
  // is twice Terra's price and slower, and Sol's rate is a promo.
  document_extraction: {
    fast: { provider: "openai", model: "gpt-5.6-luna" },
    standard: { provider: "google", model: "gemini-3.7-flash" },
    heavy: { provider: "openai", model: "gpt-5.6-terra" },
  },
  // Stays on Gemini end to end: what makes a sheet hard here is reading dense
  // linework, not returning a shape, and Gemini is the stronger reader. Cost is
  // dominated by input image tokens, so the cheap input rate is what matters.
  // The wrapper does not escalate by default, so standard and heavy are
  // override targets rather than rungs that fire.
  drawings_vision: {
    fast: { provider: "google", model: "gemini-3.1-flash-lite" },
    standard: { provider: "google", model: "gemini-3.7-flash" },
    heavy: { provider: "google", model: "gemini-3.7-flash" },
  },
  // Short text in, one nullable enum out. The cheapest model that can be held
  // to a fixed set of values wins, and strict decoding is exactly how you hold
  // it there. The caller never escalates; the upper rungs are override targets.
  spec_classification: {
    fast: { provider: "openai", model: "gpt-5-nano" },
    standard: { provider: "openai", model: "gpt-5.6-luna" },
    heavy: { provider: "google", model: "gemini-3.7-flash" },
  },
  // Billed per minute, so tier is about accuracy, not tokens. `whisper-1` is
  // retired: it is legacy, and costs twice what the better mini model does.
  // Transcription never escalates; heavy is the Gemini audio path by override.
  transcription: {
    fast: { provider: "openai", model: "gpt-4o-mini-transcribe" },
    standard: { provider: "openai", model: "gpt-transcribe" },
    heavy: { provider: "google", model: "gemini-3.7-flash" },
  },
  // Long transcript in, up to 250 structured items out, with a user waiting on
  // a 90 s timeout. Output tokens per second is the binding constraint, not
  // price, so the base tier (`standard`) is 3.7 Flash at ~370 t/s. Luna is the
  // strict-decoding fallback for the uuid/date formats; Terra is the ceiling.
  meeting_minutes: {
    fast: { provider: "openai", model: "gpt-5.6-luna" },
    standard: { provider: "google", model: "gemini-3.7-flash" },
    heavy: { provider: "openai", model: "gpt-5.6-terra" },
  },
}

/** The tier a feature runs at when the caller does not ask for one. */
export const AI_FEATURE_BASE_TIER: Record<AiFeature, AiTier> = {
  search: "standard",
  embedding: "fast",
  document_extraction: "fast",
  drawings_vision: "fast",
  spec_classification: "fast",
  transcription: "fast",
  meeting_minutes: "standard",
}

/** Next tier up, or null at the ceiling. Drives gateway escalation. */
export function nextTier(tier: AiTier): AiTier | null {
  const index = AI_TIER_VALUES.indexOf(tier)
  return index >= 0 && index < AI_TIER_VALUES.length - 1 ? AI_TIER_VALUES[index + 1] : null
}

export function defaultConfigForFeatureTier(feature: AiFeature, tier: AiTier) {
  return AI_FEATURE_TIER_DEFAULTS[feature][tier]
}

export function defaultModelForProvider(provider: AiProvider) {
  return AI_FEATURE_TIER_DEFAULTS.search.standard.provider === provider
    ? AI_FEATURE_TIER_DEFAULTS.search.standard.model
    : (AI_MODEL_CATALOG.find((entry) => entry.provider === provider && entry.tier === "standard")?.model ??
        AI_MODEL_CATALOG.find((entry) => entry.provider === provider)?.model ??
        "")
}

export function defaultModelForFeatureProvider(feature: AiFeature, provider: AiProvider) {
  const base = AI_FEATURE_TIER_DEFAULTS[feature][AI_FEATURE_BASE_TIER[feature]]
  if (base.provider === provider) return base.model
  return defaultModelForProvider(provider)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function normalizeAiProvider(value: unknown): AiProvider | null {
  if (!isNonEmptyString(value)) return null
  const normalized = value.trim().toLowerCase()
  return (AI_PROVIDER_VALUES as readonly string[]).includes(normalized) ? (normalized as AiProvider) : null
}

export function normalizeAiFeature(value: unknown): AiFeature | null {
  if (!isNonEmptyString(value)) return null
  const normalized = value.trim().toLowerCase()
  return (AI_FEATURE_VALUES as readonly string[]).includes(normalized) ? (normalized as AiFeature) : null
}

export function normalizeAiTier(value: unknown): AiTier | null {
  if (!isNonEmptyString(value)) return null
  const normalized = value.trim().toLowerCase()
  return (AI_TIER_VALUES as readonly string[]).includes(normalized) ? (normalized as AiTier) : null
}

/**
 * Infer the provider a model string belongs to, for native providers only.
 * OpenRouter model IDs are namespaced (`qwen/qwen3-max`), so a slash is the
 * signal that a model is not a bare native ID.
 */
export function inferKnownAiProviderForModel(model: string): AiProvider | null {
  const normalized = normalizeModelId(model).toLowerCase()
  if (!normalized) return null
  if (normalized.includes("/")) return "openrouter"
  if (normalized.startsWith("gemini-")) return "google"
  if (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("whisper-") ||
    normalized.startsWith("chatgpt-") ||
    /^o\d/.test(normalized)
  ) {
    return "openai"
  }
  return null
}

/**
 * Guard against the easy mistake of picking a provider that cannot serve the
 * model. Deliberately permissive: an unrecognised model is allowed through so a
 * newly released model never needs a code change to be selectable.
 */
export function validateAiProviderModelPair(provider: AiProvider, model: string) {
  const inferred = inferKnownAiProviderForModel(model)
  if (!inferred || inferred === provider) return null
  if (provider === "openrouter") return null
  return `Model "${model}" looks like a ${AI_PROVIDER_LABELS[inferred]} model. Select ${AI_PROVIDER_LABELS[inferred]} as the provider, or route it through OpenRouter.`
}

function sanitizeModel(value: unknown) {
  if (!isNonEmptyString(value)) return null
  return value.trim()
}

// ---------------------------------------------------------------------------
// Env layer
// ---------------------------------------------------------------------------

function envNameForFeature(feature: AiFeature) {
  if (feature === "embedding") return "EMBEDDING"
  if (feature === "document_extraction") return "DOCUMENT_EXTRACTION"
  if (feature === "drawings_vision") return "DRAWINGS_VISION"
  if (feature === "spec_classification") return "SPEC_CLASSIFICATION"
  if (feature === "transcription") return "TRANSCRIPTION"
  if (feature === "meeting_minutes") return "MEETING_MINUTES"
  return "AI_SEARCH"
}

/**
 * One env var shape, not six. `<FEATURE>_MODEL_DEFAULT` and
 * `<FEATURE>_PROVIDER_DEFAULT`, optionally suffixed with the tier.
 */
function resolveEnvConfig(feature: AiFeature, tier: AiTier) {
  const prefix = envNameForFeature(feature)
  const tierSuffix = `_${tier.toUpperCase()}`
  const provider =
    normalizeAiProvider(process.env[`${prefix}_PROVIDER_DEFAULT${tierSuffix}`]) ??
    normalizeAiProvider(process.env[`${prefix}_PROVIDER_DEFAULT`])
  const model =
    sanitizeModel(process.env[`${prefix}_MODEL_DEFAULT${tierSuffix}`]) ??
    sanitizeModel(process.env[`${prefix}_MODEL_DEFAULT`]) ??
    // Embeddings predate the registry and shipped under their own env name.
    // Honoured so a deployment that set it keeps the model it is already
    // storing vectors under; `EMBEDDING_MODEL_DEFAULT` is the name going forward.
    (feature === "embedding" ? sanitizeModel(process.env.AI_SEARCH_EMBEDDING_MODEL) : null)
  if (!provider && !model) return null
  const resolvedProvider = provider ?? defaultConfigForFeatureTier(feature, tier).provider
  return {
    provider: resolvedProvider,
    model: model ?? defaultConfigForFeatureTier(feature, tier).model,
  }
}

// ---------------------------------------------------------------------------
// Platform layer
// ---------------------------------------------------------------------------

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function isMissingPlatformSettingsTableError(error: unknown) {
  const code = typeof error === "object" && error ? (error as { code?: string }).code : undefined
  if (code === "42P01") return true
  const message = typeof error === "object" && error ? (error as { message?: string }).message : undefined
  return typeof message === "string" && message.includes("platform_settings") && message.includes("does not exist")
}

/**
 * Read one (feature, tier) pair out of the stored platform blob.
 *
 * Layout, with the pre-tier shape still honoured so existing rows keep working:
 *   { provider, model,                          // search / standard
 *     features: { <feature>: { provider, model, // that feature / standard
 *                              tiers: { <tier>: { provider, model } } } } }
 */
function parsePlatformAiConfigValue(
  value: unknown,
  feature: AiFeature,
  tier: AiTier,
): { provider: AiProvider; model: string } | null {
  if (!value || typeof value !== "object") return null
  const record = toRecord(value)
  const featureRecord = toRecord(toRecord(record.features)[feature])
  const tierRecord = toRecord(toRecord(featureRecord.tiers)[tier])

  const candidates: Array<Record<string, unknown>> = [tierRecord]
  // Only fall back to the feature-level (untiered) entry for the base tier, so
  // a search-level override never silently becomes the `heavy` model too.
  if (tier === AI_FEATURE_BASE_TIER[feature]) {
    candidates.push(featureRecord)
    if (feature === "search") candidates.push(record)
  }

  for (const candidate of candidates) {
    const provider = normalizeAiProvider(candidate.provider ?? candidate.ai_search_provider)
    const model = sanitizeModel(candidate.model ?? candidate.ai_search_model)
    if (provider && model) return { provider, model }
  }
  return null
}

async function readPlatformSettingsBlob(supabase: SupabaseClient): Promise<Record<string, unknown> | null> {
  const now = Date.now()
  if (platformConfigCache && platformConfigCache.expiresAt > now) {
    return platformConfigCache.value
  }

  const { data, error } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", PLATFORM_AI_SETTINGS_KEY)
    .maybeSingle()

  if (error) {
    if (!isMissingPlatformSettingsTableError(error)) {
      console.error("Failed to load platform AI defaults", error)
    }
    platformConfigCache = { expiresAt: now + PLATFORM_CONFIG_CACHE_TTL_MS, value: null }
    return null
  }

  const rawValue = (data as { value?: unknown } | null)?.value
  const value = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? toRecord(rawValue) : null
  platformConfigCache = { expiresAt: now + PLATFORM_CONFIG_CACHE_TTL_MS, value }
  return value
}

export function invalidatePlatformAiSearchDefaultCache() {
  platformConfigCache = null
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the model for a feature at a tier: platform -> env -> built-in.
 * This is what the gateway calls; everything else is a convenience wrapper.
 */
export async function getAiFeatureTierConfig({
  supabase,
  feature,
  tier,
}: {
  supabase: SupabaseClient
  feature: AiFeature
  tier?: AiTier
}): Promise<AiFeatureTierConfig> {
  const resolvedTier = tier ?? AI_FEATURE_BASE_TIER[feature]
  const blob = await readPlatformSettingsBlob(supabase)
  const platformOverride = parsePlatformAiConfigValue(blob, feature, resolvedTier)
  if (platformOverride) {
    return { ...platformOverride, feature, tier: resolvedTier, source: "platform" }
  }

  const envOverride = resolveEnvConfig(feature, resolvedTier)
  if (envOverride) {
    return { ...envOverride, feature, tier: resolvedTier, source: "env" }
  }

  return {
    ...defaultConfigForFeatureTier(feature, resolvedTier),
    feature,
    tier: resolvedTier,
    source: "default",
  }
}

export async function getPlatformAiFeatureDefaultConfig({
  supabase,
  feature,
}: {
  supabase: SupabaseClient
  feature: AiFeature
}): Promise<AiFeatureDefaultConfig> {
  const { tier: _tier, ...config } = await getAiFeatureTierConfig({ supabase, feature })
  return config
}

export async function getPlatformAiSearchDefaultConfig({
  supabase,
}: {
  supabase: SupabaseClient
}): Promise<AiSearchDefaultConfig> {
  return getPlatformAiFeatureDefaultConfig({ supabase, feature: "search" })
}

export async function getOrgAiSearchConfig({
  supabase,
  orgId,
}: {
  supabase: SupabaseClient
  orgId: string
}): Promise<AiSearchConfig> {
  const { data } = await supabase.from("org_settings").select("settings").eq("org_id", orgId).maybeSingle()

  const settings = (data?.settings as Record<string, unknown> | null) ?? {}
  const orgProvider = normalizeAiProvider(settings.ai_search_provider)
  const orgModel = sanitizeModel(settings.ai_search_model)
  const defaults = await getPlatformAiSearchDefaultConfig({ supabase })

  if (orgProvider || orgModel) {
    const provider = orgProvider ?? defaults.provider
    return {
      provider,
      model: orgModel ?? defaultModelForProvider(provider),
      source: "org",
    }
  }

  return defaults
}

export async function getOrgAiSearchConfigFromContext(context: OrgServiceContext): Promise<AiSearchConfig> {
  return getOrgAiSearchConfig({ supabase: context.supabase, orgId: context.orgId })
}

// ---------------------------------------------------------------------------
// Platform writes
// ---------------------------------------------------------------------------

export async function upsertPlatformAiFeatureDefaultConfig({
  supabase,
  feature,
  tier,
  provider,
  model,
  updatedBy,
}: {
  supabase: SupabaseClient
  feature: AiFeature
  tier?: AiTier
  provider: AiProvider
  model: string
  updatedBy?: string | null
}) {
  const resolvedTier = tier ?? AI_FEATURE_BASE_TIER[feature]
  const sanitizedModel = sanitizeModel(model) ?? defaultConfigForFeatureTier(feature, resolvedTier).model

  const existingValue = (await readPlatformSettingsBlob(supabase)) ?? {}
  const features = toRecord(existingValue.features)
  const featureRecord = toRecord(features[feature])
  const tiers = toRecord(featureRecord.tiers)

  const nextValue = {
    ...existingValue,
    features: {
      ...features,
      [feature]: {
        ...featureRecord,
        tiers: { ...tiers, [resolvedTier]: { provider, model: sanitizedModel } },
      },
    },
  }

  const { error } = await supabase
    .from("platform_settings")
    .upsert({ key: PLATFORM_AI_SETTINGS_KEY, value: nextValue, updated_by: updatedBy ?? null }, { onConflict: "key" })

  if (error) {
    throw new Error(error.message ?? "Failed to update platform AI defaults.")
  }

  platformConfigCache = { expiresAt: Date.now() + PLATFORM_CONFIG_CACHE_TTL_MS, value: nextValue }
}

export async function upsertPlatformAiSearchDefaultConfig({
  supabase,
  provider,
  model,
  updatedBy,
}: {
  supabase: SupabaseClient
  provider: AiProvider
  model: string
  updatedBy?: string | null
}) {
  return upsertPlatformAiFeatureDefaultConfig({ supabase, feature: "search", provider, model, updatedBy })
}

export async function clearPlatformAiFeatureDefaultConfig({
  supabase,
  feature,
  tier,
}: {
  supabase: SupabaseClient
  feature: AiFeature
  tier?: AiTier
}) {
  const existingValue = (await readPlatformSettingsBlob(supabase)) ?? {}
  const nextValue = { ...existingValue }
  const features = toRecord(nextValue.features)
  const featureRecord = toRecord(features[feature])
  const tiers = toRecord(featureRecord.tiers)

  // Clearing must be symmetric with reading. `parsePlatformAiConfigValue` serves
  // the legacy untiered entries AS the base tier, so clearing the base tier has
  // to remove them too — otherwise the console's Reset button is a silent no-op:
  // the tier entry goes, the untiered shadow immediately takes its place, and
  // the cell still reads "Override" after a successful-looking save.
  const clearsUntiered = !tier || tier === AI_FEATURE_BASE_TIER[feature]

  if (tier) {
    delete tiers[tier]
  } else {
    for (const key of Object.keys(tiers)) delete tiers[key]
  }

  if (clearsUntiered) {
    delete featureRecord.provider
    delete featureRecord.model
  }

  if (Object.keys(tiers).length > 0) {
    featureRecord.tiers = tiers
  } else {
    delete featureRecord.tiers
  }

  if (Object.keys(featureRecord).length > 0) {
    features[feature] = featureRecord
  } else {
    delete features[feature]
  }

  if (Object.keys(features).length > 0) {
    nextValue.features = features
  } else {
    delete nextValue.features
  }

  // The root-level pair is the oldest shape of all and means "search, base tier".
  if (feature === "search" && clearsUntiered) {
    delete nextValue.provider
    delete nextValue.model
    delete nextValue.ai_search_provider
    delete nextValue.ai_search_model
  }

  if (Object.keys(nextValue).length === 0) {
    const { error } = await supabase.from("platform_settings").delete().eq("key", PLATFORM_AI_SETTINGS_KEY)
    if (error && !isMissingPlatformSettingsTableError(error)) {
      throw new Error(error.message ?? "Failed to clear platform AI defaults.")
    }
    platformConfigCache = { expiresAt: Date.now() + PLATFORM_CONFIG_CACHE_TTL_MS, value: null }
    return
  }

  const { error } = await supabase
    .from("platform_settings")
    .upsert({ key: PLATFORM_AI_SETTINGS_KEY, value: nextValue }, { onConflict: "key" })

  if (error && !isMissingPlatformSettingsTableError(error)) {
    throw new Error(error.message ?? "Failed to clear platform AI defaults.")
  }

  platformConfigCache = { expiresAt: Date.now() + PLATFORM_CONFIG_CACHE_TTL_MS, value: nextValue }
}

export async function clearPlatformAiSearchDefaultConfig({ supabase }: { supabase: SupabaseClient }) {
  return clearPlatformAiFeatureDefaultConfig({ supabase, feature: "search" })
}
