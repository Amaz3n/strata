import type { SupabaseClient } from "@supabase/supabase-js"

import type { OrgServiceContext } from "@/lib/services/context"

export const AI_PROVIDER_VALUES = ["openai", "anthropic", "google"] as const
export type AiProvider = (typeof AI_PROVIDER_VALUES)[number]
export const AI_FEATURE_VALUES = ["search", "document_extraction", "drawings_vision", "spec_classification", "transcription", "meeting_minutes"] as const
export type AiFeature = (typeof AI_FEATURE_VALUES)[number]

export type AiConfigSource = "org" | "platform" | "env" | "default"

export interface AiSearchConfig {
  provider: AiProvider
  model: string
  source: AiConfigSource
}

export type AiDefaultConfigSource = Exclude<AiConfigSource, "org">

export interface AiSearchDefaultConfig {
  provider: AiProvider
  model: string
  source: AiDefaultConfigSource
}

export type AiFeatureDefaultConfig = AiSearchDefaultConfig & {
  feature: AiFeature
}

const PLATFORM_AI_SEARCH_SETTINGS_KEY = "ai_search_defaults"
const PLATFORM_CONFIG_CACHE_TTL_MS = 60_000

let platformConfigCache: {
  expiresAt: number
  value: Record<string, unknown> | null
} | null = null

export const AI_PROVIDER_DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-3-5-sonnet-latest",
  google: "gemini-2.0-flash",
}

export const AI_FEATURE_DEFAULT_MODELS: Record<AiFeature, Record<AiProvider, string>> = {
  search: AI_PROVIDER_DEFAULT_MODELS,
  document_extraction: {
    openai: "gpt-4.1-mini",
    anthropic: "claude-3-5-sonnet-latest",
    google: "gemini-2.5-flash-lite",
  },
  drawings_vision: {
    openai: "gpt-4.1-mini",
    anthropic: "claude-3-5-sonnet-latest",
    google: "gemini-2.5-flash-lite",
  },
  spec_classification: {
    openai: "gpt-4.1-mini",
    anthropic: "claude-3-5-haiku-latest",
    google: "gemini-2.5-flash-lite",
  },
  transcription: {
    openai: "whisper-1",
    anthropic: "claude-3-5-haiku-latest",
    google: "gemini-2.5-flash",
  },
  meeting_minutes: {
    openai: "gpt-4.1-mini",
    anthropic: "claude-3-5-haiku-latest",
    google: "gemini-2.5-flash-lite",
  },
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function normalizeAiProvider(value: unknown): AiProvider | null {
  if (!isNonEmptyString(value)) return null
  const normalized = value.trim().toLowerCase()
  if (normalized === "openai" || normalized === "anthropic" || normalized === "google") {
    return normalized
  }
  return null
}

export function defaultModelForProvider(provider: AiProvider) {
  return AI_PROVIDER_DEFAULT_MODELS[provider]
}

export function defaultModelForFeatureProvider(feature: AiFeature, provider: AiProvider) {
  return AI_FEATURE_DEFAULT_MODELS[feature]?.[provider] ?? defaultModelForProvider(provider)
}

export function inferKnownAiProviderForModel(model: string): AiProvider | null {
  const normalized = model.trim().toLowerCase().replace(/^models\//, "")
  if (!normalized) return null
  if (normalized.startsWith("gemini-")) return "google"
  if (normalized.startsWith("claude-")) return "anthropic"
  if (normalized.startsWith("gpt-") || normalized.startsWith("whisper-") || /^o\d/.test(normalized) || normalized.startsWith("chatgpt-")) {
    return "openai"
  }
  return null
}

export function validateAiProviderModelPair(provider: AiProvider, model: string) {
  const inferredProvider = inferKnownAiProviderForModel(model)
  if (!inferredProvider || inferredProvider === provider) return null
  return `Model "${model}" looks like a ${inferredProvider} model. Select ${inferredProvider} as the provider, or choose a model that belongs to ${provider}.`
}

function sanitizeModel(value: unknown) {
  if (!isNonEmptyString(value)) return null
  return value.trim()
}

function resolveProviderDefaultModel(provider: AiProvider) {
  if (provider === "openai") {
    return sanitizeModel(process.env.OPENAI_SEARCH_MODEL)
  }
  if (provider === "anthropic") {
    return sanitizeModel(process.env.ANTHROPIC_SEARCH_MODEL)
  }
  return sanitizeModel(process.env.GOOGLE_SEARCH_MODEL)
}

function envNameForFeature(feature: AiFeature) {
  if (feature === "document_extraction") return "DOCUMENT_EXTRACTION"
  if (feature === "drawings_vision") return "DRAWINGS_VISION"
  if (feature === "spec_classification") return "SPEC_CLASSIFICATION"
  if (feature === "transcription") return "TRANSCRIPTION"
  if (feature === "meeting_minutes") return "MEETING_MINUTES"
  return "AI_SEARCH"
}

function resolveFeatureProviderDefaultModel(feature: AiFeature, provider: AiProvider) {
  if (feature === "search") return resolveProviderDefaultModel(provider)
  const prefix = envNameForFeature(feature)
  const providerPrefix = provider.toUpperCase()
  return (
    sanitizeModel(process.env[`${prefix}_MODEL_DEFAULT`]) ??
    sanitizeModel(process.env[`${providerPrefix}_${prefix}_MODEL`])
  )
}

function resolveDefaultConfigFromEnv(feature: AiFeature = "search") {
  const prefix = envNameForFeature(feature)
  const provider =
    normalizeAiProvider(process.env[`${prefix}_PROVIDER_DEFAULT`]) ??
    (feature === "search" ? normalizeAiProvider(process.env.AI_SEARCH_PROVIDER_DEFAULT) : null) ??
    (feature === "search" || feature === "transcription" ? "openai" : "google")
  const model =
    sanitizeModel(process.env[`${prefix}_MODEL_DEFAULT`]) ??
    (feature === "search" ? sanitizeModel(process.env.AI_SEARCH_MODEL_DEFAULT) : null) ??
    resolveFeatureProviderDefaultModel(feature, provider) ??
    defaultModelForFeatureProvider(feature, provider)

  return { provider, model }
}

function hasEnvAiOverrides(feature: AiFeature = "search") {
  const prefix = envNameForFeature(feature)
  if (
    process.env[`${prefix}_PROVIDER_DEFAULT`] ||
    process.env[`${prefix}_MODEL_DEFAULT`] ||
    process.env[`OPENAI_${prefix}_MODEL`] ||
    process.env[`ANTHROPIC_${prefix}_MODEL`] ||
    process.env[`GOOGLE_${prefix}_MODEL`]
  ) {
    return true
  }

  if (feature !== "search") return false

  return Boolean(
    process.env.AI_SEARCH_PROVIDER_DEFAULT ||
      process.env.AI_SEARCH_MODEL_DEFAULT ||
      process.env.OPENAI_SEARCH_MODEL ||
      process.env.ANTHROPIC_SEARCH_MODEL ||
      process.env.GOOGLE_SEARCH_MODEL,
  )
}

function isMissingPlatformSettingsTableError(error: unknown) {
  const code = typeof error === "object" && error ? (error as { code?: string }).code : undefined
  if (code === "42P01") return true

  const message =
    typeof error === "object" && error ? (error as { message?: string }).message : undefined
  return typeof message === "string" && message.includes("platform_settings") && message.includes("does not exist")
}

function parsePlatformAiConfigValue(value: unknown, feature: AiFeature = "search"): { provider: AiProvider; model: string } | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const features = record.features && typeof record.features === "object" ? record.features as Record<string, unknown> : {}
  const featureRecord = toRecord(features[feature])
  const source = feature === "search" ? record : featureRecord
  const provider = normalizeAiProvider(source.provider ?? source.ai_search_provider)
  const model = sanitizeModel(source.model ?? source.ai_search_model)
  if (!provider || !model) return null
  return { provider, model }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

async function readPlatformAiConfigOverride(supabase: SupabaseClient, feature: AiFeature = "search"): Promise<{ provider: AiProvider; model: string } | null> {
  const now = Date.now()
  if (platformConfigCache && platformConfigCache.expiresAt > now) {
    return parsePlatformAiConfigValue(platformConfigCache.value, feature)
  }

  const { data, error } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", PLATFORM_AI_SEARCH_SETTINGS_KEY)
    .maybeSingle()

  if (error) {
    if (!isMissingPlatformSettingsTableError(error)) {
      console.error("Failed to load platform AI search defaults", error)
    }

    platformConfigCache = {
      expiresAt: now + PLATFORM_CONFIG_CACHE_TTL_MS,
      value: null,
    }
    return null
  }

  const rawValue = (data as { value?: unknown } | null)?.value
  const parsed = parsePlatformAiConfigValue(rawValue, feature)
  platformConfigCache = {
    expiresAt: now + PLATFORM_CONFIG_CACHE_TTL_MS,
    value: rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? toRecord(rawValue) : null,
  }
  return parsed
}

export function invalidatePlatformAiSearchDefaultCache() {
  platformConfigCache = null
}

export async function getPlatformAiSearchDefaultConfig({
  supabase,
}: {
  supabase: SupabaseClient
}): Promise<AiSearchDefaultConfig> {
  return getPlatformAiFeatureDefaultConfig({ supabase, feature: "search" })
}

export async function getPlatformAiFeatureDefaultConfig({
  supabase,
  feature,
}: {
  supabase: SupabaseClient
  feature: AiFeature
}): Promise<AiFeatureDefaultConfig> {
  const platformOverride = await readPlatformAiConfigOverride(supabase, feature)
  if (platformOverride) {
    return {
      ...platformOverride,
      feature,
      source: "platform",
    }
  }

  const envDefaults = resolveDefaultConfigFromEnv(feature)
  return {
    ...envDefaults,
    feature,
    source: hasEnvAiOverrides(feature) ? "env" : "default",
  }
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
  return upsertPlatformAiFeatureDefaultConfig({
    supabase,
    feature: "search",
    provider,
    model,
    updatedBy,
  })
}

export async function upsertPlatformAiFeatureDefaultConfig({
  supabase,
  feature,
  provider,
  model,
  updatedBy,
}: {
  supabase: SupabaseClient
  feature: AiFeature
  provider: AiProvider
  model: string
  updatedBy?: string | null
}) {
  const sanitizedModel = sanitizeModel(model) ?? defaultModelForFeatureProvider(feature, provider)
  const { data: existing } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", PLATFORM_AI_SEARCH_SETTINGS_KEY)
    .maybeSingle()
  const existingValue = toRecord((existing as { value?: unknown } | null)?.value)
  const existingFeatures = toRecord(existingValue.features)
  const nextValue =
    feature === "search"
      ? {
          ...existingValue,
          provider,
          model: sanitizedModel,
        }
      : {
          ...existingValue,
          features: {
            ...existingFeatures,
            [feature]: {
              provider,
              model: sanitizedModel,
            },
          },
        }
  const payload = {
    key: PLATFORM_AI_SEARCH_SETTINGS_KEY,
    value: nextValue,
    updated_by: updatedBy ?? null,
  }

  const { error } = await supabase.from("platform_settings").upsert(payload, {
    onConflict: "key",
  })

  if (error) {
    throw new Error(error.message ?? "Failed to update platform AI defaults.")
  }

  platformConfigCache = {
    expiresAt: Date.now() + PLATFORM_CONFIG_CACHE_TTL_MS,
    value: nextValue,
  }
}

export async function clearPlatformAiSearchDefaultConfig({ supabase }: { supabase: SupabaseClient }) {
  return clearPlatformAiFeatureDefaultConfig({ supabase, feature: "search" })
}

export async function clearPlatformAiFeatureDefaultConfig({ supabase, feature }: { supabase: SupabaseClient; feature: AiFeature }) {
  const { data: existing } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", PLATFORM_AI_SEARCH_SETTINGS_KEY)
    .maybeSingle()
  const existingValue = toRecord((existing as { value?: unknown } | null)?.value)
  const nextValue = { ...existingValue }
  const features = toRecord(nextValue.features)

  if (feature === "search") {
    delete nextValue.provider
    delete nextValue.model
    delete nextValue.ai_search_provider
    delete nextValue.ai_search_model
  } else {
    delete features[feature]
  }

  if (Object.keys(features).length > 0) {
    nextValue.features = features
  } else {
    delete nextValue.features
  }

  if (Object.keys(nextValue).length === 0) {
    const { error } = await supabase.from("platform_settings").delete().eq("key", PLATFORM_AI_SEARCH_SETTINGS_KEY)
    if (error && !isMissingPlatformSettingsTableError(error)) {
      throw new Error(error.message ?? "Failed to clear platform AI defaults.")
    }
    platformConfigCache = {
      expiresAt: Date.now() + PLATFORM_CONFIG_CACHE_TTL_MS,
      value: null,
    }
    return
  }

  const { error } = await supabase
    .from("platform_settings")
    .upsert({ key: PLATFORM_AI_SEARCH_SETTINGS_KEY, value: nextValue }, { onConflict: "key" })

  if (error && !isMissingPlatformSettingsTableError(error)) {
    throw new Error(error.message ?? "Failed to clear platform AI defaults.")
  }

  platformConfigCache = {
    expiresAt: Date.now() + PLATFORM_CONFIG_CACHE_TTL_MS,
    value: nextValue,
  }
}

export async function getOrgAiSearchConfig({
  supabase,
  orgId,
}: {
  supabase: SupabaseClient
  orgId: string
}): Promise<AiSearchConfig> {
  const { data } = await supabase
    .from("org_settings")
    .select("settings")
    .eq("org_id", orgId)
    .maybeSingle()

  const settings = (data?.settings as Record<string, unknown> | null) ?? {}
  const orgProvider = normalizeAiProvider(settings.ai_search_provider)
  const orgModel = sanitizeModel(settings.ai_search_model)
  const defaults = await getPlatformAiSearchDefaultConfig({ supabase })

  if (orgProvider || orgModel) {
    const provider = orgProvider ?? defaults.provider
    const model = orgModel ?? defaultModelForProvider(provider)
    return {
      provider,
      model,
      source: "org",
    }
  }

  return defaults
}

export async function getOrgAiSearchConfigFromContext(context: OrgServiceContext): Promise<AiSearchConfig> {
  return getOrgAiSearchConfig({ supabase: context.supabase, orgId: context.orgId })
}
