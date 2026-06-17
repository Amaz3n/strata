import "server-only"

import { ENTITY_HREF_FALLBACKS, ENTITY_INTENTS } from "@/lib/services/ai-search/config"
import type { requireOrgContext } from "@/lib/services/context"
import {
  EMBEDDING_MODEL,
  embeddingsConfigured,
  generateEmbeddingVector,
  toPgVectorLiteral,
} from "@/lib/services/search-embeddings"
import { searchEntities, type SearchEntityType, type SearchResult } from "@/lib/services/search"

type ResolvedOrgContext = Awaited<ReturnType<typeof requireOrgContext>>

type SemanticSearchRow = {
  document_id: string
  entity_type: string
  entity_id: string
  project_id: string | null
  title: string | null
  metadata: Record<string, unknown> | null
  updated_at: string | null
  similarity: number
}

const MAX_EMBEDDING_BACKFILL_DOCS = 12
const SEMANTIC_RETRIEVAL_LIMIT = 24
const SEMANTIC_SKIP_LEXICAL_THRESHOLD = 10

function dedupeResults(results: SearchResult[]) {
  const unique: SearchResult[] = []
  const seen = new Set<string>()

  for (const result of results) {
    const key = `${result.type}:${result.id}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(result)
  }

  return unique
}

function formatEntityType(type: SearchEntityType) {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function normalizeEntityType(value: unknown): SearchEntityType | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return ENTITY_INTENTS.some((definition) => definition.type === normalized)
    ? (normalized as SearchEntityType)
    : null
}

function toSearchResultFromSemanticRow(raw: SemanticSearchRow): SearchResult | null {
  const type = normalizeEntityType(raw.entity_type)
  if (!type) return null
  const id = typeof raw.entity_id === "string" ? raw.entity_id : null
  if (!id) return null

  const metadata = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}
  const typedMetadata = metadata as Record<string, unknown>
  const resolvedProjectId = (raw.project_id || typedMetadata.project_id) as string || ""
  const href = ENTITY_HREF_FALLBACKS[type]
    .replace("{id}", id)
    .replace("{project_id}", resolvedProjectId)

  const title = typeof raw.title === "string" && raw.title.trim().length > 0 ? raw.title : `Untitled ${type}`
  const score = Number.isFinite(raw.similarity) ? raw.similarity : 0

  return {
    id,
    type,
    title,
    href,
    subtitle: typeof typedMetadata.subtitle === "string" ? typedMetadata.subtitle : undefined,
    description: typeof typedMetadata.description === "string" ? typedMetadata.description : undefined,
    project_id: typeof raw.project_id === "string" ? raw.project_id : undefined,
    project_name: typeof typedMetadata.project_name === "string" ? typedMetadata.project_name : undefined,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
    score,
  }
}

async function searchSemanticDocuments({
  context,
  query,
  entityTypes,
  limit,
}: {
  context: ResolvedOrgContext
  query: string
  entityTypes: SearchEntityType[]
  limit: number
}): Promise<SearchResult[]> {
  const vector = await generateEmbeddingVector(query)
  if (!vector) return []

  const { data, error } = await context.supabase.rpc("match_search_embeddings", {
    p_org_id: context.orgId,
    p_query_embedding: toPgVectorLiteral(vector),
    p_limit: Math.max(4, Math.min(limit, SEMANTIC_RETRIEVAL_LIMIT)),
    p_entity_types: entityTypes.length > 0 ? entityTypes : null,
  })

  if (error || !Array.isArray(data)) {
    if (error) {
      console.error("Semantic retrieval query failed", error)
    }
    return []
  }

  return data
    .map((item) => toSearchResultFromSemanticRow(item as SemanticSearchRow))
    .filter((item): item is SearchResult => Boolean(item))
}

function mergeHybridResults(lexical: SearchResult[], semantic: SearchResult[], limit: number) {
  const merged = new Map<string, { result: SearchResult; score: number }>()

  lexical.forEach((item, index) => {
    const key = `${item.type}:${item.id}`
    const lexicalScore = 80 - index
    const previous = merged.get(key)
    if (!previous || lexicalScore > previous.score) {
      merged.set(key, {
        result: {
          ...item,
          score: Math.max(item.score ?? 0, lexicalScore),
        },
        score: lexicalScore,
      })
    }
  })

  semantic.forEach((item, index) => {
    const key = `${item.type}:${item.id}`
    const semanticScore = (item.score ?? 0) * 100 + (40 - index)
    const previous = merged.get(key)
    if (!previous || semanticScore > previous.score) {
      merged.set(key, {
        result: {
          ...previous?.result,
          ...item,
          score: Math.max(previous?.result.score ?? 0, item.score ?? 0),
        },
        score: semanticScore,
      })
      return
    }

    merged.set(key, {
      result: {
        ...item,
        ...previous.result,
        score: Math.max(previous.result.score ?? 0, item.score ?? 0),
      },
      score: previous.score,
    })
  })

  return Array.from(merged.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const aTime = new Date(a.result.updated_at ?? a.result.created_at ?? 0).getTime()
      const bTime = new Date(b.result.updated_at ?? b.result.created_at ?? 0).getTime()
      return bTime - aTime
    })
    .map((entry) => entry.result)
    .slice(0, limit)
}

function toEmbeddingContent(result: SearchResult) {
  return [formatEntityType(result.type), result.title, result.subtitle, result.description, result.project_name]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join("\n")
}

async function ensureSemanticEmbeddingsForResults(context: ResolvedOrgContext, results: SearchResult[]) {
  if (results.length === 0) return
  if (!embeddingsConfigured()) return

  const candidates = results.slice(0, MAX_EMBEDDING_BACKFILL_DOCS)
  for (const result of candidates) {
    const { data: doc, error: docError } = await context.supabase
      .from("search_documents")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("entity_type", result.type)
      .eq("entity_id", result.id)
      .maybeSingle()

    if (docError || !doc?.id) {
      continue
    }

    const { data: existing, error: existingError } = await context.supabase
      .from("search_embeddings")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("document_id", doc.id)
      .eq("model", EMBEDDING_MODEL)
      .limit(1)
      .maybeSingle()

    if (existingError || existing?.id) {
      continue
    }

    const embedding = await generateEmbeddingVector(toEmbeddingContent(result))
    if (!embedding || embedding.length === 0) continue

    await context.supabase.from("search_embeddings").upsert(
      {
        document_id: doc.id,
        org_id: context.orgId,
        model: EMBEDDING_MODEL,
        embedding: toPgVectorLiteral(embedding),
      },
      { onConflict: "document_id,model" },
    )
  }
}

export async function retrieveHybridResults({
  context,
  query,
  entityTypes,
  filters,
  limit,
  enableHybrid,
}: {
  context: ResolvedOrgContext
  query: string
  entityTypes: SearchEntityType[]
  filters: { projectId?: string; status?: string[] }
  limit: number
  enableHybrid: boolean
}) {
  const lexical = await searchEntities(
    query,
    entityTypes,
    filters,
    { limit, sortBy: "updated_at" },
    context.orgId,
    context,
  )

  const lexicalDeduped = dedupeResults(lexical)
  let merged = lexicalDeduped.slice(0, limit)
  const hasStrongLexicalCoverage = lexicalDeduped.length >= Math.min(limit, SEMANTIC_SKIP_LEXICAL_THRESHOLD)

  if (enableHybrid && query.trim().length > 0 && !hasStrongLexicalCoverage) {
    const semantic = await searchSemanticDocuments({
      context,
      query,
      entityTypes,
      limit: Math.min(SEMANTIC_RETRIEVAL_LIMIT, Math.max(limit, 12)),
    })
    merged = mergeHybridResults(merged, semantic, limit)
  }

  void ensureSemanticEmbeddingsForResults(context, merged)

  return merged
}
