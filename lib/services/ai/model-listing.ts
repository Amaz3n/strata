import "server-only"

import { AI_MODEL_CATALOG, normalizeModelId, type AiProvider } from "@/lib/services/ai-config"
import { getApiKeyForProvider, getOpenAiBaseUrl, getOpenRouterBaseUrl } from "@/lib/services/ai/provider"

/**
 * The models a provider will actually accept, asked of the provider itself.
 *
 * A hardcoded dropdown is stale the week after it ships, and a free-text box
 * makes a typo indistinguishable from a new release. Every provider publishes a
 * list endpoint, so the selector is built from that: always current, and a model
 * that appears in the list is one the key can really call.
 *
 * The built-in catalog is merged in as a fallback, so the picker still offers
 * sensible choices when a provider is unconfigured or its endpoint is down.
 */

const CACHE_TTL_MS = 10 * 60_000

export interface AvailableModel {
  id: string
  label: string
  /** True when Arc has a recorded price for it. */
  priced: boolean
  /** True when the model is known to accept images/PDFs. */
  vision: boolean
  /** Where the entry came from, so the UI can say when a list is a fallback. */
  source: "provider" | "catalog"
}

export interface ProviderModels {
  provider: AiProvider
  models: AvailableModel[]
  configured: boolean
  /** Set when the live list could not be fetched and the catalog is standing in. */
  warning: string | null
}

const cache = new Map<AiProvider, { expiresAt: number; value: ProviderModels }>()

function catalogModels(provider: AiProvider): AvailableModel[] {
  return AI_MODEL_CATALOG.filter((entry) => entry.provider === provider).map((entry) => ({
    id: entry.model,
    label: entry.label,
    priced: entry.inputPerMTokUsd !== null,
    vision: entry.vision,
    source: "catalog" as const,
  }))
}

function mergeWithCatalog(provider: AiProvider, live: AvailableModel[]): AvailableModel[] {
  const seen = new Set(live.map((model) => model.id))
  const extras = catalogModels(provider).filter((model) => !seen.has(model.id))
  return [...live, ...extras].sort((a, b) => a.id.localeCompare(b.id))
}

/** Catalog metadata for a live model id, so prices and vision flags survive. */
function decorate(provider: AiProvider, id: string, label?: string): AvailableModel {
  const known = AI_MODEL_CATALOG.find(
    (entry) => entry.provider === provider && entry.model === normalizeModelId(id),
  )
  return {
    id: normalizeModelId(id),
    label: label ?? known?.label ?? id,
    priced: known?.inputPerMTokUsd != null,
    vision: known?.vision ?? true,
    source: "provider",
  }
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`${response.status}`)
  return response.json() as Promise<any>
}

async function listForProvider(provider: AiProvider): Promise<ProviderModels> {
  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey) {
    return {
      provider,
      models: catalogModels(provider),
      configured: false,
      warning: "No API key configured — showing built-in options only.",
    }
  }

  try {
    if (provider === "google") {
      const base = process.env.GEMINI_BASE_URL?.replace(/\/$/, "") || "https://generativelanguage.googleapis.com/v1beta"
      const payload = await fetchJson(`${base}/models`, { "x-goog-api-key": apiKey })
      const models: AvailableModel[] = (payload?.models ?? [])
        // Only models that can actually answer a prompt.
        .filter((model: any) => (model?.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((model: any) => decorate(provider, String(model.name ?? ""), model.displayName))
        .filter((model: AvailableModel) => model.id)
      return { provider, models: mergeWithCatalog(provider, models), configured: true, warning: null }
    }

    const base =
      provider === "openrouter"
        ? getOpenRouterBaseUrl()
        : (getOpenAiBaseUrl() ?? "https://api.openai.com/v1")
    const payload = await fetchJson(`${base.replace(/\/$/, "")}/models`, {
      Authorization: `Bearer ${apiKey}`,
    })
    const models: AvailableModel[] = (payload?.data ?? [])
      .map((model: any) => decorate(provider, String(model.id ?? ""), model.name))
      .filter((model: AvailableModel) => model.id)
    return { provider, models: mergeWithCatalog(provider, models), configured: true, warning: null }
  } catch (error) {
    return {
      provider,
      models: catalogModels(provider),
      configured: true,
      warning: `Could not reach ${provider} to list models (${error instanceof Error ? error.message : "unknown"}). Showing built-in options.`,
    }
  }
}

export async function listAvailableModels(provider: AiProvider): Promise<ProviderModels> {
  const now = Date.now()
  const hit = cache.get(provider)
  if (hit && hit.expiresAt > now) return hit.value

  const value = await listForProvider(provider)
  // Only cache a real answer; a failed fetch should retry on the next open.
  if (!value.warning) cache.set(provider, { expiresAt: now + CACHE_TTL_MS, value })
  return value
}

export function invalidateModelListCache() {
  cache.clear()
}
