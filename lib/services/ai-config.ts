import type { SupabaseClient } from "@supabase/supabase-js"

import type { OrgServiceContext } from "@/lib/services/context"

export const AI_PROVIDER_VALUES = ["openai", "anthropic", "google"] as const
export type AiProvider = (typeof AI_PROVIDER_VALUES)[number]

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

const PLATFORM_AI_SEARCH_SETTINGS_KEY = "ai_search_defaults"
const PLATFORM_CONFIG_CACHE_TTL_MS = 60_000

let platformConfigCache: {
  expiresAt: number
  value: { provider: AiProvider; model: string } | null
} | null = null

export const AI_PROVIDER_DEFAULT_MODELS: Record<AiProvider, string> = {
  openai: "gpt-4.1-mini",
  anthropic: "claude-3-5-sonnet-latest",
  google: "gemini-2.0-flash",
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

function resolveDefaultConfigFromEnv() {
  const provider = normalizeAiProvider(process.env.AI_SEARCH_PROVIDER_DEFAULT) ?? "openai"
  const model =
    sanitizeModel(process.env.AI_SEARCH_MODEL_DEFAULT) ??
    resolveProviderDefaultModel(provider) ??
    defaultModelForProvider(provider)

  return { provider, model }
}

function hasEnvAiOverrides() {
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

function parsePlatformAiConfigValue(value: unknown): { provider: AiProvider; model: string } | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const provider = normalizeAiProvider(record.provider ?? record.ai_search_provider)
  const model = sanitizeModel(record.model ?? record.ai_search_model)
  if (!provider || !model) return null
  return { provider, model }
}

async function readPlatformAiConfigOverride(supabase: SupabaseClient): Promise<{ provider: AiProvider; model: string } | null> {
  const now = Date.now()
  if (platformConfigCache && platformConfigCache.expiresAt > now) {
    return platformConfigCache.value
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

  const parsed = parsePlatformAiConfigValue((data as { value?: unknown } | null)?.value)
  platformConfigCache = {
    expiresAt: now + PLATFORM_CONFIG_CACHE_TTL_MS,
    value: parsed,
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
  const platformOverride = await readPlatformAiConfigOverride(supabase)
  if (platformOverride) {
    return {
      ...platformOverride,
      source: "platform",
    }
  }

  const envDefaults = resolveDefaultConfigFromEnv()
  return {
    ...envDefaults,
    source: hasEnvAiOverrides() ? "env" : "default",
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
  const sanitizedModel = sanitizeModel(model) ?? defaultModelForProvider(provider)
  const payload = {
    key: PLATFORM_AI_SEARCH_SETTINGS_KEY,
    value: {
      provider,
      model: sanitizedModel,
    },
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
    value: {
      provider,
      model: sanitizedModel,
    },
  }
}

export async function clearPlatformAiSearchDefaultConfig({ supabase }: { supabase: SupabaseClient }) {
  const { error } = await supabase.from("platform_settings").delete().eq("key", PLATFORM_AI_SEARCH_SETTINGS_KEY)

  if (error && !isMissingPlatformSettingsTableError(error)) {
    throw new Error(error.message ?? "Failed to clear platform AI defaults.")
  }

  platformConfigCache = {
    expiresAt: Date.now() + PLATFORM_CONFIG_CACHE_TTL_MS,
    value: null,
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
