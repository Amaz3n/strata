import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  SEARCH_CONFIGS,
  buildEntitySelectClause,
  PROJECT_SCOPED_ENTITY_TYPES,
  type SearchEntityType,
} from "@/lib/services/search-config"
import {
  EMBEDDING_MODEL,
  embeddingsConfigured,
  generateEmbeddingVector,
  toPgVectorLiteral,
} from "@/lib/services/search-embeddings"

// Write-through population of the unified search index (search_documents +
// search_embeddings). Unlike the lazy read-through cache in search.ts, this
// keeps the index authoritative: rows are (re)written on create/update and
// removed on delete, driven asynchronously via the outbox queue.

// Maps the entity_type values passed to recordAudit() onto search entity types.
// Most are identity; a few tables index under a different search type.
const AUDIT_ENTITY_TYPE_TO_SEARCH: Record<string, SearchEntityType> = {
  project: "project",
  task: "task",
  file: "file",
  document: "file",
  contact: "contact",
  company: "company",
  invoice: "invoice",
  payment: "payment",
  budget: "budget",
  estimate: "estimate",
  commitment: "commitment",
  change_order: "change_order",
  contract: "contract",
  proposal: "proposal",
  rfi: "rfi",
  submittal: "submittal",
  drawing_set: "drawing_set",
  drawing_sheet: "drawing_sheet",
  daily_log: "daily_log",
  punch_item: "punch_item",
  schedule_item: "schedule_item",
  photo: "photo",
  prospect: "prospect",
  // Aliases → canonical search type
  vendor_bill: "payable",
  bill: "payable",
  Bill: "payable",
  project_expense: "expense",
}

export function mapAuditEntityTypeToSearchType(auditEntityType: string): SearchEntityType | null {
  return AUDIT_ENTITY_TYPE_TO_SEARCH[auditEntityType] ?? null
}

export type ReindexOp = "upsert" | "delete"

export const REINDEX_JOB_TYPE = "reindex_search"
export const REMOVE_INDEX_JOB_TYPE = "remove_search_index"

interface EntityRef {
  orgId: string
  entityType: SearchEntityType
  entityId: string
}

// Enqueue a re-index (or removal) onto the outbox. Best-effort: failures here
// must never break the originating mutation, so callers should not await-throw.
export async function enqueueReindex(
  { orgId, entityType, entityId, op }: EntityRef & { op: ReindexOp },
  supabase?: SupabaseClient,
) {
  if (!orgId || !entityId) return
  const client = supabase ?? createServiceSupabaseClient()
  const { error } = await client.from("outbox").insert({
    org_id: orgId,
    job_type: op === "delete" ? REMOVE_INDEX_JOB_TYPE : REINDEX_JOB_TYPE,
    payload: { entity_type: entityType, entity_id: entityId },
    run_at: new Date().toISOString(),
  })
  if (error) {
    console.error("[search-index] failed to enqueue reindex", { entityType, entityId, error: error.message })
  }
}

function coerceProjectName(projectRelation: unknown): string | undefined {
  if (projectRelation && typeof projectRelation === "object" && !Array.isArray(projectRelation)) {
    const name = (projectRelation as Record<string, unknown>).name
    return typeof name === "string" ? name : undefined
  }
  if (Array.isArray(projectRelation) && projectRelation[0] && typeof projectRelation[0] === "object") {
    const name = (projectRelation[0] as Record<string, unknown>).name
    return typeof name === "string" ? name : undefined
  }
  return undefined
}

function formatSubtitlePart(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (field === "total_cents" || field === "amount_cents") {
    return `$${(Number(value) / 100).toLocaleString()}`
  }
  if (field === "size_bytes") {
    return `${(Number(value) / (1024 * 1024)).toFixed(1)} MB`
  }
  if (field === "status" && typeof value === "string") {
    return value.charAt(0).toUpperCase() + value.slice(1)
  }
  return String(value)
}

// Build the search_documents body from the entity's text-bearing fields
// (descriptions + searchable text columns). Numeric/id columns are skipped so
// the tsvector/trigram content stays meaningful.
function buildBody(row: Record<string, unknown>, fields: string[]): string {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const field of fields) {
    if (seen.has(field)) continue
    seen.add(field)
    const value = row[field]
    if (typeof value === "string" && value.trim().length > 0) {
      parts.push(value.trim())
    } else if (Array.isArray(value)) {
      const arrayText = value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .join(" ")
      if (arrayText) parts.push(arrayText)
    } else if (field === "metadata" && value && typeof value === "object") {
      const metadata = value as Record<string, any>
      const extractedText =
        typeof metadata.search?.extracted_text === "string"
          ? metadata.search.extracted_text
          : typeof metadata.extracted_text === "string"
            ? metadata.extracted_text
            : ""
      if (extractedText.trim()) parts.push(extractedText.trim())
    }
  }
  return parts.join(" ")
}

export async function removeFromIndex(
  { orgId, entityType, entityId }: EntityRef,
  supabase?: SupabaseClient,
) {
  const client = supabase ?? createServiceSupabaseClient()
  const { error } = await client
    .from("search_documents")
    .delete()
    .eq("org_id", orgId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
  if (error) {
    throw new Error(`removeFromIndex failed for ${entityType}:${entityId}: ${error.message}`)
  }
}

// Reads the source row and upserts its search_documents row. If the source row
// no longer exists, the index entry is removed instead (handles deletes that
// arrive as an upsert, and stale rows). Returns the document id, or null when
// the entity was absent.
export async function reindexEntity(
  { orgId, entityType, entityId }: EntityRef,
  supabase?: SupabaseClient,
): Promise<string | null> {
  const config = SEARCH_CONFIGS[entityType]
  if (!config) return null

  const client = supabase ?? createServiceSupabaseClient()
  const includeProject = PROJECT_SCOPED_ENTITY_TYPES.has(entityType)
  const selectClause = buildEntitySelectClause(entityType, config, includeProject)

  const { data: row, error } = await client
    .from(config.table)
    .select(selectClause)
    .eq("org_id", orgId)
    .eq("id", entityId)
    .maybeSingle<Record<string, unknown>>()

  if (error) {
    throw new Error(`reindexEntity read failed for ${entityType}:${entityId}: ${error.message}`)
  }

  if (!row) {
    // Source row gone — make sure the index doesn't keep serving a stale hit.
    await removeFromIndex({ orgId, entityType, entityId }, client)
    return null
  }

  const projectId =
    entityType === "project"
      ? entityId
      : typeof row.project_id === "string"
        ? row.project_id
        : null
  const projectName = includeProject ? coerceProjectName(row.projects) : undefined

  const title =
    typeof row[config.titleField] === "string" && (row[config.titleField] as string).trim().length > 0
      ? (row[config.titleField] as string)
      : `Untitled ${entityType}`

  const subtitle = (config.subtitleFields ?? [])
    .map((field) => formatSubtitlePart(field, row[field]))
    .filter((part): part is string => part !== null)
    .join(" • ")

  const description = (config.descriptionFields ?? [])
    .map((field) => row[field])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")

  const body = buildBody(row, [...(config.descriptionFields ?? []), ...config.searchableFields])
  const href = config.hrefTemplate.replace("{id}", entityId).replace("{project_id}", projectId ?? "")

  const { data: upserted, error: upsertError } = await client
    .from("search_documents")
    .upsert(
      {
        org_id: orgId,
        entity_type: entityType,
        entity_id: entityId,
        project_id: projectId,
        title,
        body,
        metadata: {
          href,
          subtitle: subtitle || null,
          description: description || null,
          project_id: projectId,
          project_name: projectName ?? null,
          title,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id,entity_type,entity_id" },
    )
    .select("id")
    .maybeSingle<{ id: string }>()

  if (upsertError) {
    throw new Error(`reindexEntity upsert failed for ${entityType}:${entityId}: ${upsertError.message}`)
  }

  const documentId = upserted?.id ?? null

  // Embedding is best-effort and must not fail the index write.
  if (documentId && embeddingsConfigured()) {
    try {
      const content = [title, subtitle, description, projectName].filter(Boolean).join("\n")
      const vector = await generateEmbeddingVector(content)
      if (vector && vector.length > 0) {
        await client.from("search_embeddings").upsert(
          {
            document_id: documentId,
            org_id: orgId,
            model: EMBEDDING_MODEL,
            embedding: toPgVectorLiteral(vector),
          },
          { onConflict: "document_id,model" },
        )
      }
    } catch (embedError) {
      console.error("[search-index] embedding upsert failed", {
        entityType,
        entityId,
        error: embedError instanceof Error ? embedError.message : String(embedError),
      })
    }
  }

  return documentId
}
