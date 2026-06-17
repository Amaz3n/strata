import "server-only"

import { ANALYTICS_ENTITY_CONFIGS, ENTITY_INTENTS, ENTITY_STATUS_VALUES } from "@/lib/services/ai-search/config"
import { resolveProjectFromHints, type ProjectRef } from "@/lib/services/ai-search/projects"
import { retrieveHybridResults } from "@/lib/services/ai-search/retrieval"
import { buildTextSearchOrCondition } from "@/lib/services/ai-search/sql"
import type { requireOrgContext } from "@/lib/services/context"
import type { SearchEntityType, SearchResult } from "@/lib/services/search"

type ResolvedOrgContext = Awaited<ReturnType<typeof requireOrgContext>>

const ANALYTICS_BATCH_SIZE = 1_000
const MAX_ANALYTICS_ROWS_SOFT_LIMIT = 100_000

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

type AnalyticsRow = {
  id: string
  title: string
  status?: string
  amountCents?: number
  projectId?: string
  createdAt?: string
  dueDate?: string
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

function toStatusLabel(status: string) {
  return status.replace(/_/g, " ")
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
    .slice(0, 4)
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

// Canonical AR aging buckets, in display order.
const AGING_BUCKET_ORDER: string[] = ["Current", "1–30", "31–60", "61–90", "90+"]
// Statuses that mean an invoice is no longer owing — excluded from aging.
const AR_SETTLED_STATUSES = new Set(["paid", "void", "voided", "cancelled", "canceled", "written_off", "refunded", "closed"])

// Buckets a due date into an AR aging band by days past due (relative to today).
function agingBucketLabel(dueDate?: string): string | null {
  if (!dueDate) return null
  const due = new Date(dueDate)
  if (!Number.isFinite(due.getTime())) return null
  const days = Math.floor((Date.now() - due.getTime()) / (24 * 60 * 60 * 1000))
  if (days <= 0) return "Current"
  if (days <= 30) return "1–30"
  if (days <= 60) return "31–60"
  if (days <= 90) return "61–90"
  return "90+"
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
  const selectFields = Array.from(
    new Set([
      "id",
      config.titleField,
      config.statusField,
      config.amountField,
      config.projectIdField,
      config.createdAtField,
      config.dueDateField,
    ].filter((field): field is string => Boolean(field))),
  )

  const toAnalyticsRow = (entry: unknown): AnalyticsRow => {
    const value = entry as Record<string, unknown>
    const id = typeof value.id === "string" ? value.id : ""
    const titleValue = value[config.titleField]
    const statusValue = config.statusField ? value[config.statusField] : undefined
    const amountValue = config.amountField ? value[config.amountField] : undefined
    const projectIdValue = config.projectIdField ? value[config.projectIdField] : undefined
    const createdAtValue = config.createdAtField ? value[config.createdAtField] : undefined
    const dueDateValue = config.dueDateField ? value[config.dueDateField] : undefined

    return {
      id,
      title: typeof titleValue === "string" && titleValue.trim().length > 0 ? titleValue : id || "Untitled",
      status: typeof statusValue === "string" ? statusValue : undefined,
      amountCents: config.amountField ? toFiniteNumber(amountValue) : undefined,
      projectId: typeof projectIdValue === "string" ? projectIdValue : undefined,
      createdAt: typeof createdAtValue === "string" ? createdAtValue : undefined,
      dueDate: typeof dueDateValue === "string" ? dueDateValue : undefined,
    }
  }

  const runAnalyticsQuery = async (textQuery: string): Promise<{ rows: AnalyticsRow[]; error: unknown | null }> => {
    const rows: AnalyticsRow[] = []
    let offset = 0

    while (offset < MAX_ANALYTICS_ROWS_SOFT_LIMIT) {
      let queryBuilder = context.supabase
        .from(config.table)
        .select(selectFields.join(","))
        .eq("org_id", context.orgId)
        .range(offset, offset + ANALYTICS_BATCH_SIZE - 1)

      if (resolvedProject?.id && config.projectIdField) {
        queryBuilder = queryBuilder.eq(config.projectIdField, resolvedProject.id)
      }

      if (intent.statuses.length > 0 && config.statusField) {
        queryBuilder = queryBuilder.in(config.statusField, intent.statuses)
      }

      if (intent.dateRangeDays && config.createdAtField) {
        const since = new Date(Date.now() - intent.dateRangeDays * 24 * 60 * 60 * 1000).toISOString()
        queryBuilder = queryBuilder.gte(config.createdAtField, since)
      }

      if (textQuery && config.searchableFields.length > 0) {
        const condition = buildTextSearchOrCondition(config.searchableFields, textQuery)
        if (condition) {
          queryBuilder = queryBuilder.or(condition)
        }
      }

      if (config.createdAtField) {
        queryBuilder = queryBuilder.order(config.createdAtField, { ascending: false })
      }

      const { data, error } = await queryBuilder
      if (error) return { rows: [], error }

      const batch = Array.isArray(data) ? data : []
      if (batch.length === 0) break
      rows.push(...batch.map(toAnalyticsRow))
      if (batch.length < ANALYTICS_BATCH_SIZE) break

      offset += ANALYTICS_BATCH_SIZE
    }

    return { rows, error: null }
  }

  let analyticsResult = await runAnalyticsQuery(intent.textQuery)

  // If text filtering likely over-constrained results, retry without text filter.
  if (analyticsResult.rows.length === 0 && intent.textQuery.trim().length > 0) {
    analyticsResult = await runAnalyticsQuery("")
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

  const rows = analyticsResult.rows

  const projectNameMap = new Map<string, string>()
  if (intent.groupBy === "project" && config.projectIdField) {
    const projectIds = Array.from(new Set(rows.map((row) => row.projectId).filter((id): id is string => Boolean(id)))).slice(0, 200)
    if (projectIds.length > 0) {
      const { data: projectsData, error: projectsError } = await context.supabase
        .from("projects")
        .select("id,name")
        .eq("org_id", context.orgId)
        .in("id", projectIds)

      if (projectsError) {
        console.error("Failed to resolve project names for analytics", projectsError)
      } else if (Array.isArray(projectsData)) {
        for (const project of projectsData) {
          const id = typeof project.id === "string" ? project.id : null
          const name = typeof project.name === "string" ? project.name : null
          if (id && name) projectNameMap.set(id, name)
        }
      }
    }
  }

  const bucketMap = new Map<string, { label: string; count: number; amountCents: number }>()
  for (const row of rows) {
    let label = "Total"
    if (intent.groupBy === "status") {
      label = row.status ? toStatusLabel(row.status) : "Unknown"
    } else if (intent.groupBy === "project") {
      label = row.projectId ? projectNameMap.get(row.projectId) ?? "Unknown project" : "No project"
    } else if (intent.groupBy === "month") {
      const date = row.createdAt ? new Date(row.createdAt) : null
      if (date && Number.isFinite(date.getTime())) {
        const year = date.getUTCFullYear()
        const month = `${date.getUTCMonth() + 1}`.padStart(2, "0")
        label = `${year}-${month}`
      } else {
        label = "Unknown month"
      }
    } else if (intent.groupBy === "aging") {
      // Aging covers only invoices that are still owing.
      if (row.status && AR_SETTLED_STATUSES.has(row.status.toLowerCase())) continue
      const agingLabel = agingBucketLabel(row.dueDate)
      if (!agingLabel) continue
      label = agingLabel
    }

    const current = bucketMap.get(label) ?? { label, count: 0, amountCents: 0 }
    current.count += 1
    current.amountCents += row.amountCents ?? 0
    bucketMap.set(label, current)
  }

  const buckets = Array.from(bucketMap.values())
    .map((bucket) => ({
      label: bucket.label,
      count: bucket.count,
      amountCents: bucket.amountCents,
      metricValue: toAnalyticsMetricValue(intent.metric, bucket),
    }))
    .filter((bucket) => bucket.count > 0)

  if (intent.groupBy === "month") {
    buckets.sort((a, b) => a.label.localeCompare(b.label))
  } else if (intent.groupBy === "aging") {
    buckets.sort((a, b) => AGING_BUCKET_ORDER.indexOf(a.label) - AGING_BUCKET_ORDER.indexOf(b.label))
  } else {
    buckets.sort((a, b) => b.metricValue - a.metricValue)
  }

  const normalizedGroupBy = normalizeAnalyticsGroupBy(intent.groupBy, intent.entityType)
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
    rowCount: rows.length,
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

