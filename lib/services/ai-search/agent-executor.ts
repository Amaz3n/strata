import "server-only"

import type { AiProvider } from "@/lib/services/ai-config"
import { executeAnalyticsToolLayer } from "@/lib/services/ai-search/analytics"
import {
  buildArtifactForAnalyticsIntent,
  buildArtifactForStructuredIntent,
  buildTableArtifact,
} from "@/lib/services/ai-search/artifacts"
import {
  ANALYTICS_ENTITY_CONFIGS,
  ENTITY_SEMANTIC_FALLBACKS,
} from "@/lib/services/ai-search/config"
import {
  CROSS_DOMAIN_INTENT_RE,
  detectEntityMentions,
  extractRetrievalQuery,
  normalizeAnalyticsGroupBy,
  normalizeAnalyticsMetric,
  normalizePlannerStatuses,
  normalizeQuery,
  planQueryWithAgent,
  toAnalyticsIntentFromAgent,
  toStructuredIntentFromAgent,
  type QueryAgentPlan,
} from "@/lib/services/ai-search/planning"
import { executeStructuredToolLayer } from "@/lib/services/ai-search/structured"
import type { AiSearchArtifact, AiSearchExportLink } from "@/lib/services/ai-search"
import type { AiSearchRuntimeFlags } from "@/lib/services/ai-search-flags"
import { requireOrgContext } from "@/lib/services/context"
import type { SearchEntityType, SearchResult } from "@/lib/services/search"

const PLANNER_LOOP_MAX_ATTEMPTS = 3

type ResolvedOrgContext = Awaited<ReturnType<typeof requireOrgContext>>

type QueryAgentExecution = {
  answerFallback: string
  relatedResults: SearchResult[]
  rowCount: number
  additionalContext?: string
  artifactData: { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] }
  confidence: "low" | "medium" | "high"
  missingData: string[]
}

type QueryAgentStepExecution = {
  step: QueryAgentPlan
  execution: QueryAgentExecution
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

function buildMultiStepPlans(query: string, basePlan: QueryAgentPlan, maxSteps = 3): QueryAgentPlan[] {
  const plans: QueryAgentPlan[] = [basePlan]
  const mentioned = Array.from(
    new Set<SearchEntityType>([...(basePlan.relatedEntityTypes ?? []), ...detectEntityMentions(query)]),
  )
  if (mentioned.length <= 1 && !CROSS_DOMAIN_INTENT_RE.test(query)) {
    return plans
  }

  for (const entityType of mentioned) {
    if (entityType === basePlan.entityType) continue
    const hasAnalytics = Boolean(ANALYTICS_ENTITY_CONFIGS[entityType])
    const metricHint = hasAnalytics ? normalizeAnalyticsMetric(basePlan.metric, entityType) : "count"
    const groupByHint = hasAnalytics ? normalizeAnalyticsGroupBy(basePlan.groupBy, entityType) : "none"
    const statuses = normalizePlannerStatuses(basePlan.statuses, entityType)

    plans.push({
      ...basePlan,
      operation: hasAnalytics ? "aggregate" : "list",
      entityType,
      metric: hasAnalytics ? metricHint : "count",
      groupBy: hasAnalytics ? groupByHint : "none",
      statuses,
      limit: Math.max(5, Math.min(basePlan.limit, 12)),
    })
    if (plans.length >= maxSteps) break
  }

  return plans
}

function mergeQueryAgentStepExecutions(orgId: string, stepExecutions: QueryAgentStepExecution[]): QueryAgentExecution {
  const mergedResults = dedupeResults(stepExecutions.flatMap((item) => item.execution.relatedResults))
  const rowCount = stepExecutions.reduce((acc, item) => acc + item.execution.rowCount, 0)
  const confidenceOrder = { low: 0, medium: 1, high: 2 } as const
  const mergedConfidence = stepExecutions.reduce<"low" | "medium" | "high">((acc, item) => {
    return confidenceOrder[item.execution.confidence] > confidenceOrder[acc] ? item.execution.confidence : acc
  }, "low")
  const missingData = Array.from(
    new Set(
      stepExecutions.flatMap((item) => item.execution.missingData).filter((value) => value.trim().length > 0),
    ),
  )

  const contextLines = stepExecutions.map((item) => {
    const metricLabel =
      item.step.metric === "count" ? "count" : item.step.metric === "avg_amount" ? "avg_amount" : "sum_amount"
    return `Step ${formatEntityType(item.step.entityType)} -> op=${item.step.operation}, metric=${metricLabel}, rows=${item.execution.rowCount}`
  })

  const answerFallback = stepExecutions
    .map((item) => item.execution.answerFallback.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .join("\n\n")

  const tableArtifact = buildTableArtifact({
    orgId,
    title: "Cross-domain summary",
    columns: ["Entity", "Operation", "Rows"],
    rows: stepExecutions.map((item) => [formatEntityType(item.step.entityType), item.step.operation, item.execution.rowCount]),
  })

  return {
    answerFallback: answerFallback || `I analyzed ${stepExecutions.length} data slices and found ${rowCount.toLocaleString()} records.`,
    relatedResults: mergedResults.slice(0, 16),
    rowCount,
    additionalContext: contextLines.join("\n"),
    artifactData: tableArtifact ?? stepExecutions[0]?.execution.artifactData ?? {},
    confidence: mergedConfidence,
    missingData,
  }
}

async function executeQueryAgentPlan(
  plan: QueryAgentPlan,
  context: ResolvedOrgContext,
  options: { enableHybridRetrieval?: boolean } = {},
): Promise<QueryAgentExecution> {
  const enableHybridRetrieval = options.enableHybridRetrieval === true
  if (plan.operation === "aggregate") {
    const execution = await executeAnalyticsToolLayer(toAnalyticsIntentFromAgent(plan), context, {
      enableHybridRetrieval,
    })
    const metricLabel =
      plan.metric === "count" ? "count" : plan.metric === "avg_amount" ? "average amount (USD)" : "total amount (USD)"
    const additionalContext = [
      "Agent execution",
      `Operation: aggregate`,
      `Entity: ${plan.entityType}`,
      `Metric: ${metricLabel}`,
      `GroupBy: ${plan.groupBy}`,
      `Rows: ${execution.rowCount}`,
      ...execution.buckets.slice(0, 8).map((bucket) => `Bucket ${bucket.label}: metric=${bucket.metricValue}; count=${bucket.count}`),
    ].join("\n")
    return {
      answerFallback: execution.answer,
      relatedResults: execution.relatedResults,
      rowCount: execution.rowCount,
      additionalContext,
      artifactData: buildArtifactForAnalyticsIntent({ orgId: context.orgId, execution, chartType: plan.chartType }),
      confidence: execution.rowCount >= 10 ? "high" : execution.rowCount > 0 ? "medium" : "low",
      missingData:
        execution.rowCount > 0
          ? []
          : [`No ${pluralize(formatEntityType(plan.entityType).toLowerCase(), 2)} matched this scope.`],
    }
  }

  const execution = await executeStructuredToolLayer(toStructuredIntentFromAgent(plan), context, {
    enableHybridRetrieval,
  })
  const rowCount = execution.totalCount ?? execution.relatedResults.length
  const additionalContext = [
    "Agent execution",
    "Operation: list",
    `Entity: ${plan.entityType}`,
    `Rows: ${rowCount}`,
  ].join("\n")
  return {
    answerFallback: execution.answer,
    relatedResults: execution.relatedResults,
    rowCount,
    additionalContext,
    artifactData: buildArtifactForStructuredIntent(context.orgId, toStructuredIntentFromAgent(plan), execution),
    confidence: rowCount >= 8 ? "high" : rowCount > 0 ? "medium" : "low",
    missingData: rowCount > 0 ? [] : [`No ${pluralize(formatEntityType(plan.entityType).toLowerCase(), 2)} matched this scope.`],
  }
}

function normalizePlanForEntity(plan: QueryAgentPlan, entityType: SearchEntityType): QueryAgentPlan {
  const normalizedStatuses = normalizePlannerStatuses(plan.statuses, entityType)
  return {
    ...plan,
    entityType,
    statuses: normalizedStatuses,
    metric: normalizeAnalyticsMetric(plan.metric, entityType),
    groupBy: normalizeAnalyticsGroupBy(plan.groupBy, entityType),
  }
}

function buildAgentRepairCandidates(plan: QueryAgentPlan): QueryAgentPlan[] {
  const variants: QueryAgentPlan[] = [plan]
  if (plan.textQuery.trim().length > 0) {
    variants.push({ ...plan, textQuery: "" })
  }
  if (plan.dateRangeDays) {
    variants.push({ ...plan, dateRangeDays: undefined })
  }
  if (plan.textQuery.trim().length > 0 && plan.dateRangeDays) {
    variants.push({ ...plan, textQuery: "", dateRangeDays: undefined })
  }

  const fallbackEntities = ENTITY_SEMANTIC_FALLBACKS[plan.entityType] ?? []
  for (const fallbackEntity of fallbackEntities.slice(0, 3)) {
    const normalizedFallback = normalizePlanForEntity(plan, fallbackEntity)
    variants.push(normalizedFallback)
    if (normalizedFallback.textQuery.trim().length > 0) {
      variants.push({ ...normalizedFallback, textQuery: "" })
    }
  }

  const deduped: QueryAgentPlan[] = []
  const seen = new Set<string>()
  for (const candidate of variants) {
    const key = JSON.stringify(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(candidate)
    if (deduped.length >= 9) break
  }
  return deduped
}

async function executeQueryAgentWithRepairs(
  plan: QueryAgentPlan,
  context: ResolvedOrgContext,
  options: { enableHybridRetrieval?: boolean } = {},
): Promise<{ finalPlan: QueryAgentPlan; execution: QueryAgentExecution }> {
  const attempts = buildAgentRepairCandidates(plan)
  const [firstAttempt, ...remainingAttempts] = attempts
  const initialPlan = firstAttempt ?? plan

  let bestPlan = initialPlan
  let bestExecution = await executeQueryAgentPlan(initialPlan, context, options)

  if (bestExecution.rowCount > 0) {
    return { finalPlan: bestPlan, execution: bestExecution }
  }

  for (const candidate of remainingAttempts) {
    const candidateExecution = await executeQueryAgentPlan(candidate, context, options)
    if (candidateExecution.rowCount > bestExecution.rowCount) {
      bestExecution = candidateExecution
      bestPlan = candidate
    }
    if (candidateExecution.rowCount > 0) {
      return { finalPlan: candidate, execution: candidateExecution }
    }
  }

  return { finalPlan: bestPlan, execution: bestExecution }
}

async function executeMultiStepQueryAgentPlan({
  context,
  query,
  basePlan,
  enableMultiStep,
  enableHybridRetrieval,
}: {
  context: ResolvedOrgContext
  query: string
  basePlan: QueryAgentPlan
  enableMultiStep: boolean
  enableHybridRetrieval: boolean
}): Promise<{ finalPlan: QueryAgentPlan; execution: QueryAgentExecution; stepPlans: QueryAgentPlan[] }> {
  const stepPlans = enableMultiStep ? buildMultiStepPlans(query, basePlan) : [basePlan]
  if (stepPlans.length <= 1) {
    const single = await executeQueryAgentWithRepairs(basePlan, context, { enableHybridRetrieval })
    return { finalPlan: single.finalPlan, execution: single.execution, stepPlans: [single.finalPlan] }
  }

  const stepExecutions = (
    await Promise.all(
      stepPlans.map(async (stepPlan) => {
        const step = await executeQueryAgentWithRepairs(stepPlan, context, { enableHybridRetrieval })
        return {
          step: step.finalPlan,
          execution: step.execution,
        } satisfies QueryAgentStepExecution
      }),
    )
  ).filter((item): item is QueryAgentStepExecution => Boolean(item))

  const merged = mergeQueryAgentStepExecutions(context.orgId, stepExecutions)
  return {
    finalPlan: stepExecutions[0]?.step ?? basePlan,
    execution: merged,
    stepPlans: stepExecutions.map((item) => item.step),
  }
}

function buildPlannerRequeryCandidates({
  normalizedQuery,
  plannerQuery,
  sessionContext,
}: {
  normalizedQuery: string
  plannerQuery: string
  sessionContext: string
}) {
  const candidates = [
    plannerQuery,
    normalizedQuery,
    extractRetrievalQuery(normalizedQuery),
    sessionContext
      ? `${normalizedQuery}\nFocus on organization records, and infer the most likely dataset and time range.`
      : "",
  ]
    .map((candidate) => normalizeQuery(candidate))
    .filter((candidate) => candidate.length > 0)

  const unique: string[] = []
  for (const candidate of candidates) {
    if (unique.includes(candidate)) continue
    unique.push(candidate)
    if (unique.length >= PLANNER_LOOP_MAX_ATTEMPTS) break
  }
  return unique
}

export async function runPlannerExecutorLoop({
  normalizedQuery,
  plannerQuery,
  sessionContext,
  provider,
  model,
  limit,
  context,
  runtimeFlags,
}: {
  normalizedQuery: string
  plannerQuery: string
  sessionContext: string
  provider: AiProvider
  model: string
  limit: number
  context: ResolvedOrgContext
  runtimeFlags: AiSearchRuntimeFlags
}) {
  const candidateQueries = buildPlannerRequeryCandidates({
    normalizedQuery,
    plannerQuery,
    sessionContext,
  })

  let bestResult: {
    attempt: number
    plannedFromQuery: string
    agentPlan: QueryAgentPlan
    finalPlan: QueryAgentPlan
    execution: QueryAgentExecution
    stepPlans: QueryAgentPlan[]
  } | null = null

  for (let index = 0; index < candidateQueries.length; index += 1) {
    const planningQuery = candidateQueries[index] ?? normalizedQuery
    const agentPlan = await planQueryWithAgent(planningQuery, provider, model, limit)
    if (!agentPlan) continue

    const { finalPlan, execution, stepPlans } = await executeMultiStepQueryAgentPlan({
      context,
      query: normalizedQuery,
      basePlan: agentPlan,
      enableMultiStep: runtimeFlags.multiStepPlanning,
      enableHybridRetrieval: runtimeFlags.hybridRetrieval,
    })

    const score = execution.rowCount * 10 + (execution.confidence === "high" ? 3 : execution.confidence === "medium" ? 2 : 1)
    const bestScore = bestResult
      ? bestResult.execution.rowCount * 10 +
        (bestResult.execution.confidence === "high" ? 3 : bestResult.execution.confidence === "medium" ? 2 : 1)
      : -1

    if (!bestResult || score > bestScore) {
      bestResult = {
        attempt: index + 1,
        plannedFromQuery: planningQuery,
        agentPlan,
        finalPlan,
        execution,
        stepPlans,
      }
    }

    if (execution.rowCount > 0 && execution.confidence !== "low") {
      break
    }
  }

  return bestResult
}
