import "server-only"

// Shared embedding helpers for the unified search index.
//
// These mirror the embedding logic that lives privately inside ai-search.ts so
// the write-through indexer (outbox handler) and any backfill job can generate
// embeddings without depending on the 6.5k-line AI module. Embedding is always
// best-effort: when no key is configured these return null and callers fall back
// to FTS/fuzzy retrieval.

const REQUEST_TIMEOUT_MS = 12_000
export const EMBEDDING_MODEL = process.env.AI_SEARCH_EMBEDDING_MODEL?.trim() || "text-embedding-3-small"
const EMBEDDING_INPUT_MAX_CHARS = 4_000

function getOpenAiBaseUrl() {
  const configured = process.env.OPENAI_BASE_URL ?? process.env.OPENAI_COMPAT_BASE_URL
  if (!configured) return undefined
  const normalized = configured.trim()
  return normalized.length > 0 ? normalized : undefined
}

export function getEmbeddingsApiKey() {
  const explicit = process.env.OPENAI_API_KEY?.trim()
  if (explicit) return explicit
  if (getOpenAiBaseUrl()) {
    return process.env.OPENAI_COMPAT_API_KEY?.trim() || "local-dev-key"
  }
  return undefined
}

export function embeddingsConfigured() {
  return Boolean(getEmbeddingsApiKey())
}

function getEmbeddingApiBaseUrl() {
  const configured = getOpenAiBaseUrl()
  if (configured) {
    return configured.endsWith("/") ? configured.slice(0, -1) : configured
  }
  return "https://api.openai.com/v1"
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

export async function generateEmbeddingVector(input: string): Promise<number[] | null> {
  const apiKey = getEmbeddingsApiKey()
  if (!apiKey) return null

  const normalizedInput = normalizeEmbeddingInput(input)
  if (!normalizedInput) return null

  try {
    const endpoint = `${getEmbeddingApiBaseUrl()}/embeddings`
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: normalizedInput,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null

    const payload = (await response.json()) as { data?: Array<{ embedding?: unknown }> }
    const embedding = payload.data?.[0]?.embedding
    if (!Array.isArray(embedding)) return null

    const vector = embedding
      .map((value) => (typeof value === "number" && Number.isFinite(value) ? value : null))
      .filter((value): value is number => value !== null)
    return vector.length > 0 ? vector : null
  } catch {
    return null
  }
}
