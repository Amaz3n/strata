import "server-only"

import { ANALYTICS_ENTITY_CONFIGS, ENTITY_INTENTS, ENTITY_STATUS_VALUES } from "@/lib/services/ai-search/config"
import { resolveProjectFromHints, type ProjectRef } from "@/lib/services/ai-search/projects"
import { retrieveHybridResults } from "@/lib/services/ai-search/retrieval"
import type { requireOrgContext } from "@/lib/services/context"
import type { SearchEntityType, SearchResult } from "@/lib/services/search"

type ResolvedOrgContext = Awaited<ReturnType<typeof requireOrgContext>>

export type AnalyticsMetric = "count" | "sum_amount" | "avg_amount"
export type AnalyticsGroupBy = "none" | "status" | "project" | "month" | "aging"

export type AnalyticsIntent = {
  kind: "analytics"
  operation: "aggregate"
  entityType: SearchEntityType
  metric: AnalyticsMetric
  groupBy: AnalyticsGroupBy
  statuses: string[]
  textQuery: string
  projectName?: string
  dateRangeDays?: number
  limit: number
}

export type AnalyticsBucket = {
  label: string
  count: number
  amountCents: number
  metricValue: number
}

export type AnalyticsExecution = {
  answer: string
  entityLabel: string
  project?: ProjectRef | null
  rowCount: number
  metric: AnalyticsMetric
  groupBy: AnalyticsGroupBy
  buckets: AnalyticsBucket[]
  relatedResults: SearchResult[]
}

type AnalyticsAggregateRow = {
  label: unknown
  row_count: unknown
  amount_cents: unknown
}

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

function pluralize(word: string, count: number) {
  if (count === 1) return word
  if (word.endsWith("s")) return word
  return `${word}s`
}

function normalizeAnalyticsGroupBy(groupBy: AnalyticsGroupBy, entityType: SearchEntityType): AnalyticsGroupBy {
  const config = ANALYTICS_ENTITY_CONFIGS[entityType]
  if (groupBy === "aging") return entityType === "invoice" ? "aging" : "none"
  if (groupBy === "status" && !config?.statusField) return "none"
  if (groupBy === "project" && !config?.projectIdField) return "none"
  if (groupBy === "month" && !config?.createdAtField) return "none"
  return groupBy
}

function toFiniteNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function toAnalyticsMetricValue(metric: AnalyticsMetric, bucket: { count: number; amountCents: number }) {
  if (metric === "count") return bucket.count
  if (metric === "avg_amount") {
    if (bucket.count === 0) return 0
    return bucket.amountCents / bucket.count / 100
  }
  return bucket.amountCents / 100
}

function formatAnalyticsMetricValue(metric: AnalyticsMetric, value: number) {
  if (metric === "count") return Math.round(value).toLocaleString()
  if (metric === "avg_amount") {
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  }
  return `$${Math.round(value).toLocaleString()}`
}

function formatRangeLabel(days?: number) {
  if (!days) return "all time"
  if (days % 30 === 0) {
    const months = days / 30
    if (months === 1) return "last 1 month"
    return `last ${months} months`
  }
  return `last ${days} days`
}

function buildAnalyticsFallbackAnswer({
  execution,
  intent,
}: {
  execution: AnalyticsExecution
  intent: AnalyticsIntent
}) {
  const { rowCount, buckets, entityLabel, project, metric, groupBy } = execution
  const scope = project?.name ? ` for ${project.name}` : ""
  const range = formatRangeLabel(intent.dateRangeDays)

  if (rowCount === 0 || buckets.length === 0) {
    return `I found no ${pluralize(entityLabel, 2)}${scope} in the ${range} window for that analytics query.`
  }

  if (groupBy === "none") {
    const total = buckets[0]
    if (!total) {
      return `I found ${rowCount} ${pluralize(entityLabel, rowCount)}${scope} in the ${range} window.`
    }

    if (metric === "count") {
      return `I found ${formatAnalyticsMetricValue(metric, total.metricValue)} ${pluralize(entityLabel, rowCount)}${scope} in the ${range} window.`
    }

    const metricLabel = metric === "avg_amount" ? "Average amount" : "Total amount"
    return `${metricLabel} across ${pluralize(entityLabel, rowCount)}${scope} in the ${range} window is ${formatAnalyticsMetricValue(metric, total.metricValue)}.`
  }

  const topGroups = buckets
    .slice(0, groupBy === "aging" ? AGING_BUCKET_ORDER.length : 4)
    .map((bucket) => `${bucket.label}: ${formatAnalyticsMetricValue(metric, bucket.metricValue)}`)
    .join("; ")

  const groupLabel =
    groupBy === "status"
      ? "status"
      : groupBy === "project"
        ? "project"
        : groupBy === "month"
          ? "month"
          : groupBy === "aging"
            ? "aging"
            : "group"

  return `I analyzed ${rowCount.toLocaleString()} ${pluralize(entityLabel, rowCount)}${scope} in the ${range} window. Top ${groupLabel} breakdown: ${topGroups}.`
}

const AGING_BUCKET_ORDER: string[] = ["Current", "1–30", "31–60", "61–90", "90+"]

function normalizeAgingLabel(label: string) {
  return label.replace("1-30", "1–30").replace("31-60", "31–60").replace("61-90", "61–90")
}

function normalizeAggregateRow(row: AnalyticsAggregateRow): AnalyticsBucket | null {
  const label = typeof row.label === "string" && row.label.trim().length > 0 ? normalizeAgingLabel(row.label.trim()) : "Unknown"
  const count = Math.max(0, Math.round(toFiniteNumber(row.row_count)))
  const amountCents = Math.round(toFiniteNumber(row.amount_cents))
  if (count === 0) return null
  return {
    label,
    count,
    amountCents,
    metricValue: 0,
  }
}

export async function executeAnalyticsToolLayer(
  intent: AnalyticsIntent,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  options: { enableHybridRetrieval?: boolean } = {},
): Promise<AnalyticsExecution> {
  const enableHybridRetrieval = options.enableHybridRetrieval === true
  const config = ANALYTICS_ENTITY_CONFIGS[intent.entityType]
  const entityLabel = ENTITY_INTENTS.find((entity) => entity.type === intent.entityType)?.label ?? formatEntityType(intent.entityType).toLowerCase()
  if (!config) {
    return {
      answer: `I can't run advanced analytics for ${entityLabel} yet. Try asking for a list or count instead.`,
      entityLabel,
      rowCount: 0,
      metric: intent.metric,
      groupBy: intent.groupBy,
      buckets: [],
      relatedResults: [],
    }
  }

  const resolvedProject = await resolveProjectFromHints(context, intent.projectName, intent.textQuery)
  const normalizedGroupBy = normalizeAnalyticsGroupBy(intent.groupBy, intent.entityType)
  const since = intent.dateRangeDays && config.createdAtField
    ? new Date(Date.now() - intent.dateRangeDays * 24 * 60 * 60 * 1000).toISOString()
    : undefined
  const rpcLimit =
    normalizedGroupBy === "none"
      ? 1
      : normalizedGroupBy === "aging"
        ? AGING_BUCKET_ORDER.length
        : Math.max(8, Math.min(intent.limit, 50))

  const runAnalyticsAggregate = async (textQuery: string): Promise<{ buckets: AnalyticsBucket[]; error: unknown | null }> => {
    const { data, error } = await context.supabase.rpc("ai_search_analytics_aggregate", {
      p_org_id: context.orgId,
      p_entity_type: intent.entityType,
      p_group_by: normalizedGroupBy,
      p_statuses: intent.statuses.length > 0 && config.statusField ? intent.statuses : null,
      p_text_query: textQuery.trim().length > 0 && config.searchableFields.length > 0 ? textQuery.trim() : null,
      p_project_id: resolvedProject?.id ?? null,
      p_since: since ?? null,
      p_limit: rpcLimit,
    })

    if (error) return { buckets: [], error }
    const rows = Array.isArray(data) ? (data as AnalyticsAggregateRow[]) : []
    return {
      buckets: rows
        .map(normalizeAggregateRow)
        .filter((bucket): bucket is AnalyticsBucket => bucket !== null),
      error: null,
    }
  }

  let analyticsResult = await runAnalyticsAggregate(intent.textQuery)

  // If text filtering likely over-constrained results, retry without text filter.
  if (analyticsResult.buckets.length === 0 && intent.textQuery.trim().length > 0) {
    analyticsResult = await runAnalyticsAggregate("")
  }
  if (analyticsResult.error) {
    console.error("Analytics query failed", {
      entityType: intent.entityType,
      metric: intent.metric,
      groupBy: intent.groupBy,
      statuses: intent.statuses,
      textQuery: intent.textQuery,
      dateRangeDays: intent.dateRangeDays,
      error: analyticsResult.error,
    })
    return {
      answer: `I couldn't run analytics for ${entityLabel} right now. Please try again.`,
      entityLabel,
      project: resolvedProject,
      rowCount: 0,
      metric: intent.metric,
      groupBy: intent.groupBy,
      buckets: [],
      relatedResults: [],
    }
  }

  const buckets = analyticsResult.buckets.map((bucket) => ({
    ...bucket,
    metricValue: toAnalyticsMetricValue(intent.metric, bucket),
  }))

  if (normalizedGroupBy === "aging") {
    const byLabel = new Map(buckets.map((bucket) => [bucket.label, bucket]))
    for (const label of AGING_BUCKET_ORDER) {
      if (!byLabel.has(label)) {
        byLabel.set(label, {
          label,
          count: 0,
          amountCents: 0,
          metricValue: 0,
        })
      }
    }
    buckets.splice(0, buckets.length, ...Array.from(byLabel.values()))
  }

  if (normalizedGroupBy === "month") {
    buckets.sort((a, b) => a.label.localeCompare(b.label))
  } else if (normalizedGroupBy === "aging") {
    buckets.sort((a, b) => AGING_BUCKET_ORDER.indexOf(a.label) - AGING_BUCKET_ORDER.indexOf(b.label))
  } else {
    buckets.sort((a, b) => b.metricValue - a.metricValue)
  }

  const filters: { projectId?: string; status?: string[] } = {}
  if (resolvedProject?.id) {
    filters.projectId = resolvedProject.id
  }
  if (intent.statuses.length > 0 && ENTITY_STATUS_VALUES[intent.entityType]?.length) {
    filters.status = intent.statuses
  }

  const rawRelated = await retrieveHybridResults({
    context,
    query: intent.textQuery,
    entityTypes: [intent.entityType],
    filters,
    limit: Math.max(8, Math.min(intent.limit, 12)),
    enableHybrid: enableHybridRetrieval,
  })
  const relatedResults = dedupeResults(rawRelated).slice(0, Math.min(intent.limit, 12))

  const execution: AnalyticsExecution = {
    answer: "",
    entityLabel,
    project: resolvedProject,
    rowCount: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    metric: intent.metric,
    groupBy: normalizedGroupBy,
    buckets,
    relatedResults,
  }

  execution.answer = buildAnalyticsFallbackAnswer({
    execution,
    intent: {
      ...intent,
      groupBy: normalizedGroupBy,
    },
  })

  return execution
}
