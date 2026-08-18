import "server-only"

import { embed, embedMany } from "ai"

import { getAiFeatureTierConfig, type AiProvider } from "@/lib/services/ai-config"
import { getApiKeyForProvider, resolveTextEmbeddingModel } from "@/lib/services/ai/provider"
import { recordAiUsage } from "@/lib/services/ai/usage"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Vectors for the unified search index.
 *
 * These used to be a hand-rolled `fetch` to `/embeddings` with its own key
 * chain, its own base-URL logic and a hand-parsed response — which meant the
 * one AI call Arc makes most often was the one call nobody could see. Every
 * vector is now an AI SDK `embed`/`embedMany` through the shared provider table
 * and lands a row in `ai_usage_events`, so semantic search shows up on the spend
 * dashboard next to everything else.
 *
 * Two properties callers depend on:
 *
 * - BEST-EFFORT, ALWAYS. No key, no provider, a refused request or a
 *   wrong-width vector all return null, and retrieval falls back to full text.
 *   An embedding failure must never fail the write that triggered it.
 * - DIMENSION IS LOAD-BEARING. `search_embeddings.embedding` is declared
 *   `vector(1536)`. A model returning any other width is rejected here rather
 *   than sent to Postgres, because the insert would fail per row and the index
 *   would silently stop growing. This is the guard that makes the model safe to
 *   expose on the AI console at all.
 */

/** The declared width of `search_embeddings.embedding`. Not negotiable in code. */
export const EMBEDDING_DIMENSIONS = 1536

const REQUEST_TIMEOUT_MS = 12_000
const EMBEDDING_INPUT_MAX_CHARS = 4_000
/** `embedMany` fans out; keep a lid on it so a backfill cannot swamp the provider. */
const MAX_PARALLEL_EMBED_CALLS = 4

export interface EmbeddingVector {
  vector: number[]
  /** The model that actually produced it — stored alongside, never assumed. */
  model: string
}

interface ResolvedEmbeddingModel {
  provider: AiProvider
  model: string
  apiKey: string
}

/**
 * Is any embedding-capable provider reachable?
 *
 * Deliberately synchronous and deliberately coarse: callers use it to skip work
 * on the hot path, and the authoritative answer — which provider, which model,
 * does it resolve — is made per call below. OpenRouter is excluded because it
 * does not proxy the embeddings endpoint.
 */
export function embeddingsConfigured() {
  return Boolean(getApiKeyForProvider("openai") ?? getApiKeyForProvider("google"))
}

/**
 * The (provider, model) semantic search runs on right now.
 *
 * Exported because callers must filter existing rows by the SAME model before
 * deciding a document needs embedding — asking "is this indexed?" against the
 * wrong model re-embeds the whole corpus.
 */
export async function resolveEmbeddingModel(): Promise<ResolvedEmbeddingModel | null> {
  try {
    const config = await getAiFeatureTierConfig({
      supabase: createServiceSupabaseClient(),
      feature: "embedding",
    })
    const apiKey = getApiKeyForProvider(config.provider)
    if (!apiKey) return null
    return { provider: config.provider, model: config.model, apiKey }
  } catch (error) {
    console.warn("[search-embeddings] Could not resolve the embedding model", error)
    return null
  }
}

function normalizeEmbeddingInput(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, EMBEDDING_INPUT_MAX_CHARS)
}

// Postgres `vector` literal: "[0.12345678,-0.98765432,...]".
export function toPgVectorLiteral(values: number[]) {
  const normalized = values
    .filter((value) => Number.isFinite(value))
    .map((value) => Number(value).toFixed(8))
  return `[${normalized.join(",")}]`
}

/**
 * Reject anything the column cannot hold. A short vector means the provider
 * returned something unexpected; a long one means the configured model is the
 * wrong size, which is a config mistake worth a log line every time.
 */
function acceptVector(values: readonly number[], model: string): number[] | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  if (finite.length !== EMBEDDING_DIMENSIONS) {
    console.warn(
      `[search-embeddings] "${model}" returned ${finite.length} dimensions; ` +
        `search_embeddings holds ${EMBEDDING_DIMENSIONS}. Vector discarded.`,
    )
    return null
  }
  return finite
}

function recordEmbeddingUsage({
  resolved,
  tokens,
  latencyMs,
  orgId,
  status,
  errorKind,
  errorMessage,
}: {
  resolved: ResolvedEmbeddingModel
  tokens: number | null
  latencyMs: number
  orgId: string | null
  status: "ok" | "error"
  errorKind?: string | null
  errorMessage?: string | null
}) {
  void recordAiUsage(createServiceSupabaseClient(), {
    orgId,
    feature: "embedding",
    tier: "fast",
    provider: resolved.provider,
    model: resolved.model,
    // Embeddings consume input and emit vectors, never output tokens. Reporting
    // zero rather than null keeps the cost estimate honest instead of unpriced.
    usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens },
    latencyMs,
    attempt: 1,
    escalatedFrom: null,
    status,
    errorKind: errorKind ?? null,
    errorMessage: errorMessage ?? null,
    entityType: null,
    entityId: null,
  })
}

/** One vector, or null. `orgId` attributes the spend when the caller knows it. */
export async function generateEmbeddingVector(
  input: string,
  options: { orgId?: string | null } = {},
): Promise<EmbeddingVector | null> {
  const normalizedInput = normalizeEmbeddingInput(input)
  if (!normalizedInput) return null

  const resolved = await resolveEmbeddingModel()
  if (!resolved) return null

  const model = resolveTextEmbeddingModel(resolved.provider, resolved.apiKey, resolved.model)
  if (!model) return null

  const startedAt = Date.now()
  try {
    const result = await embed({
      model,
      value: normalizedInput,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      experimental_telemetry: {
        isEnabled: true,
        functionId: "ai.embedding",
        metadata: { provider: resolved.provider, model: resolved.model, orgId: options.orgId ?? "unknown" },
      },
    })

    const vector = acceptVector(result.embedding, resolved.model)
    recordEmbeddingUsage({
      resolved,
      tokens: result.usage?.tokens ?? null,
      latencyMs: Date.now() - startedAt,
      orgId: options.orgId ?? null,
      status: vector ? "ok" : "error",
      errorKind: vector ? null : "dimension_mismatch",
    })

    return vector ? { vector, model: resolved.model } : null
  } catch (error) {
    recordEmbeddingUsage({
      resolved,
      tokens: null,
      latencyMs: Date.now() - startedAt,
      orgId: options.orgId ?? null,
      status: "error",
      errorKind: "provider_error",
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Many vectors in one round trip, for backfills and batch indexing.
 *
 * Returns a slot per input, null where that input was empty or its vector was
 * the wrong width, so callers can zip results back onto their rows positionally.
 */
export async function generateEmbeddingVectors(
  inputs: string[],
  options: { orgId?: string | null } = {},
): Promise<Array<EmbeddingVector | null>> {
  const normalized = inputs.map(normalizeEmbeddingInput)
  const fillable = normalized
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value.length > 0)
  if (fillable.length === 0) return inputs.map(() => null)

  const resolved = await resolveEmbeddingModel()
  if (!resolved) return inputs.map(() => null)

  const model = resolveTextEmbeddingModel(resolved.provider, resolved.apiKey, resolved.model)
  if (!model) return inputs.map(() => null)

  const startedAt = Date.now()
  try {
    const result = await embedMany({
      model,
      values: fillable.map((entry) => entry.value),
      maxParallelCalls: MAX_PARALLEL_EMBED_CALLS,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      experimental_telemetry: {
        isEnabled: true,
        functionId: "ai.embedding",
        metadata: { provider: resolved.provider, model: resolved.model, orgId: options.orgId ?? "unknown" },
      },
    })

    const output: Array<EmbeddingVector | null> = inputs.map(() => null)
    for (const [position, entry] of fillable.entries()) {
      const vector = acceptVector(result.embeddings[position] ?? [], resolved.model)
      if (vector) output[entry.index] = { vector, model: resolved.model }
    }

    recordEmbeddingUsage({
      resolved,
      tokens: result.usage?.tokens ?? null,
      latencyMs: Date.now() - startedAt,
      orgId: options.orgId ?? null,
      status: "ok",
    })
    return output
  } catch (error) {
    recordEmbeddingUsage({
      resolved,
      tokens: null,
      latencyMs: Date.now() - startedAt,
      orgId: options.orgId ?? null,
      status: "error",
      errorKind: "provider_error",
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    return inputs.map(() => null)
  }
}
