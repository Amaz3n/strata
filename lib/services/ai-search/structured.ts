import "server-only"

import { COUNT_QUERY_CONFIGS, ENTITY_STATUS_VALUES } from "@/lib/services/ai-search/config"
import { retrieveHybridResults } from "@/lib/services/ai-search/retrieval"
import { buildTextSearchOrCondition } from "@/lib/services/ai-search/sql"
import type { requireOrgContext } from "@/lib/services/context"
import type { SearchEntityType, SearchResult } from "@/lib/services/search"

type StructuredOperation = "list" | "count" | "list_and_count"

export type StructuredIntent = {
  kind: "structured"
  operation: StructuredOperation
  entityType: SearchEntityType
  entityLabel: string
  entityTokens: string[]
  statuses: string[]
  textQuery: string
  limit: number
}

type StatusBreakdownEntry = {
  status: string
  count: number
}

export type StructuredExecution = {
  answer: string
  relatedResults: SearchResult[]
  totalCount: number | null
  statusBreakdown: StatusBreakdownEntry[]
}

type ResolvedOrgContext = Awaited<ReturnType<typeof requireOrgContext>>

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

function toStatusLabel(status: string) {
  return status.replace(/_/g, " ")
}

function formatStatusPhrase(statuses: string[]) {
  if (statuses.length === 0) return ""
  if (statuses.length === 1) return toStatusLabel(statuses[0] ?? "")
  if (statuses.length === 2) {
    return `${toStatusLabel(statuses[0] ?? "")} or ${toStatusLabel(statuses[1] ?? "")}`
  }
  return `${statuses.slice(0, -1).map(toStatusLabel).join(", ")}, or ${toStatusLabel(statuses[statuses.length - 1] ?? "")}`
}

function pluralize(word: string, count: number) {
  if (count === 1) return word
  if (word.endsWith("s")) return word
  return `${word}s`
}

function buildStructuredListAnswer(intent: StructuredIntent, relatedResults: SearchResult[]) {
  const statusPrefix = intent.statuses.length > 0 ? `${formatStatusPhrase(intent.statuses)} ` : ""
  if (relatedResults.length === 0) {
    return `I found no ${statusPrefix}${pluralize(intent.entityLabel, 2)} in your org for this query.`
  }

  const heading = `Here ${relatedResults.length === 1 ? "is" : "are"} ${relatedResults.length} ${statusPrefix}${pluralize(intent.entityLabel, relatedResults.length)}:`
  const lines = relatedResults.slice(0, intent.limit).map((item) => {
    const projectPart = item.project_name ? ` (${item.project_name})` : ""
    return `- ${item.title}${projectPart}`
  })

  return [heading, ...lines].join("\n")
}

function buildStructuredCountAnswer(intent: StructuredIntent, count: number, relatedResults: SearchResult[]) {
  const statusPrefix = intent.statuses.length > 0 ? `${formatStatusPhrase(intent.statuses)} ` : ""
  const entityLabel = pluralize(intent.entityLabel, count)
  if (count <= 0) {
    return `You currently have 0 ${statusPrefix}${entityLabel}.`
  }

  const highlights = relatedResults
    .slice(0, 3)
    .map((item) => item.title)
    .join(", ")

  if (!highlights) {
    return `You currently have ${count} ${statusPrefix}${entityLabel}.`
  }

  return `You currently have ${count} ${statusPrefix}${entityLabel}. Recent examples: ${highlights}.`
}

function buildStructuredListAndCountAnswer(intent: StructuredIntent, count: number, relatedResults: SearchResult[]) {
  const statusPrefix = intent.statuses.length > 0 ? `${formatStatusPhrase(intent.statuses)} ` : ""
  const entityLabel = pluralize(intent.entityLabel, count)

  if (count <= 0) {
    return `You currently have 0 ${statusPrefix}${entityLabel}.`
  }

  const lines = relatedResults.slice(0, intent.limit).map((item) => {
    const projectPart = item.project_name ? ` (${item.project_name})` : ""
    return `- ${item.title}${projectPart}`
  })

  const heading = `You currently have ${count} ${statusPrefix}${entityLabel}. Top ${Math.min(relatedResults.length, intent.limit)}:`
  return [heading, ...lines].join("\n")
}

async function countStructuredIntentMatches(
  intent: StructuredIntent,
  context: ResolvedOrgContext,
) {
  const config = COUNT_QUERY_CONFIGS[intent.entityType]
  if (!config) return null

  let queryBuilder = context.supabase.from(config.table).select("id", { count: "exact", head: true }).eq("org_id", context.orgId)

  if (intent.statuses.length > 0 && ENTITY_STATUS_VALUES[intent.entityType]?.length) {
    queryBuilder = queryBuilder.in("status", intent.statuses)
  }

  if (intent.textQuery) {
    const searchCondition = buildTextSearchOrCondition(config.searchableFields, intent.textQuery)
    if (searchCondition) {
      queryBuilder = queryBuilder.or(searchCondition)
    }
  }

  const { count, error } = await queryBuilder
  if (error) {
    console.error("Structured count query failed", {
      entityType: intent.entityType,
      statuses: intent.statuses,
      textQuery: intent.textQuery,
      error,
    })
    return null
  }

  return count ?? 0
}

async function countStructuredStatusBreakdown(
  intent: StructuredIntent,
  context: ResolvedOrgContext,
): Promise<StatusBreakdownEntry[]> {
  const allowedStatuses = ENTITY_STATUS_VALUES[intent.entityType]
  const config = COUNT_QUERY_CONFIGS[intent.entityType]
  if (!allowedStatuses || allowedStatuses.length === 0 || !config) return []

  const statuses = intent.statuses.length > 0 ? intent.statuses : allowedStatuses
  if (statuses.length === 0) return []

  const counts = await Promise.all(
    statuses.map(async (status) => {
      let queryBuilder = context.supabase
        .from(config.table)
        .select("id", { count: "exact", head: true })
        .eq("org_id", context.orgId)
        .eq("status", status)

      if (intent.textQuery) {
        const searchCondition = buildTextSearchOrCondition(config.searchableFields, intent.textQuery)
        if (searchCondition) {
          queryBuilder = queryBuilder.or(searchCondition)
        }
      }

      const { count, error } = await queryBuilder
      if (error) {
        console.error("Structured status count query failed", {
          entityType: intent.entityType,
          status,
          textQuery: intent.textQuery,
          error,
        })
        return null
      }

      return {
        status,
        count: count ?? 0,
      } satisfies StatusBreakdownEntry
    }),
  )

  return counts
    .filter((entry): entry is StatusBreakdownEntry => entry !== null && entry.count > 0)
    .sort((a, b) => b.count - a.count)
}

export async function executeStructuredToolLayer(
  intent: StructuredIntent,
  context: ResolvedOrgContext,
  options: { enableHybridRetrieval?: boolean } = {},
): Promise<StructuredExecution> {
  const enableHybridRetrieval = options.enableHybridRetrieval === true
  const hasStatusSupport = Boolean(ENTITY_STATUS_VALUES[intent.entityType]?.length)
  const filters = hasStatusSupport && intent.statuses.length > 0 ? { status: intent.statuses } : {}
  const shouldFetchList = intent.operation === "list" || intent.operation === "list_and_count" || intent.operation === "count"
  const listLimit = intent.operation === "count" ? Math.min(8, intent.limit) : intent.limit

  let rawResults = shouldFetchList
    ? await retrieveHybridResults({
        context,
        query: intent.textQuery,
        entityTypes: [intent.entityType],
        filters,
        limit: listLimit,
        enableHybrid: enableHybridRetrieval,
      })
    : []

  if (shouldFetchList && rawResults.length === 0 && intent.textQuery.trim().length > 0) {
    rawResults = await retrieveHybridResults({
      context,
      query: "",
      entityTypes: [intent.entityType],
      filters,
      limit: listLimit,
      enableHybrid: false,
    })
  }

  const relatedResults = dedupeResults(rawResults).slice(0, listLimit)
  const [totalCount, statusBreakdown] = await Promise.all([
    intent.operation === "count" || intent.operation === "list_and_count"
      ? countStructuredIntentMatches(intent, context)
      : Promise.resolve(null),
    countStructuredStatusBreakdown(intent, context),
  ])

  let answer = ""
  if (intent.operation === "count") {
    answer = buildStructuredCountAnswer(intent, totalCount ?? relatedResults.length, relatedResults)
  } else if (intent.operation === "list_and_count") {
    answer = buildStructuredListAndCountAnswer(intent, totalCount ?? relatedResults.length, relatedResults)
  } else {
    answer = buildStructuredListAnswer(intent, relatedResults)
  }

  return {
    answer,
    relatedResults,
    totalCount,
    statusBreakdown,
  }
}
