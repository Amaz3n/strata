import "server-only"

import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import type { EmbeddingModel, LanguageModel, TranscriptionModel } from "ai"

import { normalizeModelId, type AiProvider } from "@/lib/services/ai-config"

/**
 * Turning a (provider, model) pair into something the AI SDK can call.
 *
 * Google and OpenAI are native so the hot paths keep native file/PDF handling.
 * OpenRouter rides the first-party OpenAI-compatible provider, which is what
 * makes "try Qwen this week" a settings change instead of a dependency change.
 *
 * Three modalities resolve here — language, embedding, transcription — because
 * they share one key chain and one provider table. A modality a provider does
 * not serve returns null rather than throwing, so the caller can fall back
 * (keyword search, a different provider) instead of failing the request.
 */

const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

export function getOpenAiBaseUrl() {
  const configured = process.env.OPENAI_BASE_URL ?? process.env.OPENAI_COMPAT_BASE_URL
  const normalized = configured?.trim()
  return normalized ? normalized : undefined
}

/**
 * Overridable so the same code path can point at Together, DashScope, Fireworks
 * or a local vLLM without another provider entry.
 */
export function getOpenRouterBaseUrl() {
  const configured = process.env.OPENROUTER_BASE_URL?.trim()
  return configured || OPENROUTER_DEFAULT_BASE_URL
}

export function getApiKeyForProvider(provider: AiProvider): string | undefined {
  if (provider === "openai") {
    const configured = process.env.OPENAI_API_KEY?.trim()
    if (configured) return configured
    // An OpenAI-compatible base URL implies a local or proxied gateway that may
    // not require a real key; the SDK still wants a non-empty string.
    if (getOpenAiBaseUrl()) return process.env.OPENAI_COMPAT_API_KEY?.trim() || "local-dev-key"
    return undefined
  }
  if (provider === "openrouter") {
    return process.env.OPENROUTER_API_KEY?.trim() || undefined
  }
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || undefined
}

export function isProviderConfigured(provider: AiProvider) {
  return Boolean(getApiKeyForProvider(provider))
}

export function resolveLanguageModel(provider: AiProvider, apiKey: string, model: string): LanguageModel {
  const normalizedModel = normalizeModelId(model)

  if (provider === "openai") {
    return createOpenAI({ apiKey, baseURL: getOpenAiBaseUrl() })(normalizedModel)
  }

  if (provider === "openrouter") {
    return openRouterProvider(apiKey)(normalizedModel)
  }

  return createGoogleGenerativeAI({ apiKey })(normalizedModel)
}

function openRouterProvider(apiKey: string) {
  return createOpenAICompatible({
    name: "openrouter",
    apiKey,
    baseURL: getOpenRouterBaseUrl(),
    headers: {
      // OpenRouter attributes traffic with these; harmless elsewhere.
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL?.trim() || "https://arc.build",
      "X-Title": process.env.OPENROUTER_SITE_NAME?.trim() || "Arc",
    },
  })
}

/**
 * Text-embedding model for a (provider, model) pair.
 *
 * OpenRouter is deliberately excluded: it proxies chat completions, not the
 * embeddings endpoint, so a vector request there fails at the transport rather
 * than degrading. Callers treat null as "no semantic search" and fall back to
 * full-text, which is the behaviour an unconfigured deployment already has.
 */
export function resolveTextEmbeddingModel(
  provider: AiProvider,
  apiKey: string,
  model: string,
): EmbeddingModel | null {
  const normalizedModel = normalizeModelId(model)

  if (provider === "openai") {
    return createOpenAI({ apiKey, baseURL: getOpenAiBaseUrl() }).textEmbeddingModel(normalizedModel)
  }

  if (provider === "google") {
    return createGoogleGenerativeAI({ apiKey }).textEmbeddingModel(normalizedModel)
  }

  return null
}

/**
 * Speech-to-text model. OpenAI is the only provider with a dedicated
 * transcription endpoint; Google transcribes through its language model with an
 * audio file part, so it resolves through `resolveLanguageModel` instead.
 */
export function resolveTranscriptionModel(
  provider: AiProvider,
  apiKey: string,
  model: string,
): TranscriptionModel | null {
  if (provider !== "openai") return null
  return createOpenAI({ apiKey, baseURL: getOpenAiBaseUrl() }).transcription(normalizeModelId(model))
}
