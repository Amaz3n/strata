import "server-only"

import { getOrgAiSearchConfigFromContext, type AiProvider } from "@/lib/services/ai-config"
import {
  buildAiActionDraft,
  createAiSearchActionRequest,
  isAiActionToolKey,
  type AiSearchAction,
} from "@/lib/services/ai-search/actions"
import {
  executeEntityAttributeLookupIntent,
  type EntityAttributeIntent,
} from "@/lib/services/ai-search/attributes"
import type { AnalyticsExecution, AnalyticsGroupBy, AnalyticsIntent, AnalyticsMetric } from "@/lib/services/ai-search/analytics"
import { runPlannerExecutorLoop } from "@/lib/services/ai-search/agent-executor"
import {
  buildArtifactForAnalysisIntent,
  buildArtifactForAnalyticsIntent,
  buildArtifactForFallback,
  buildArtifactForStructuredIntent,
  buildTableArtifact,
} from "@/lib/services/ai-search/artifacts"
import {
  ANALYTICS_ENTITY_CONFIGS,
  ATTRIBUTE_TARGET_NOISE_TOKENS,
  BASE_ENTITY_TYPES,
  COUNT_QUERY_CONFIGS,
  DOCUMENT_ENTITY_TYPES,
  ENTITY_ATTRIBUTE_CONFIGS,
  ENTITY_INTENTS,
  ENTITY_SEMANTIC_FALLBACKS,
  ENTITY_STATUS_VALUES,
  FIELD_ENTITY_TYPES,
  FINANCIAL_ENTITY_TYPES,
  STATUS_ALIASES,
} from "@/lib/services/ai-search/config"
import {
  generateAnswerWithLlm,
  generateGeneralAssistantAnswer,
  getApiKeyForProvider,
  getOpenAiBaseUrl,
  resolveLanguageModel,
} from "@/lib/services/ai-search/llm"
import {
  buildAnalysisFallbackAnswer,
  executeCanonicalMetricIntent,
  executeDrawPaymentStatusIntent,
  formatFinancialRollupContext,
  loadFinancialRollup,
  type FinancialRollup,
} from "@/lib/services/ai-search/financial"
import {
  inferConfidenceFromResponse,
  resolveCitations,
  verifyGroundedAnswer,
} from "@/lib/services/ai-search/grounding"
import {
  appendAiSearchMessage,
  ensureAiSearchSession,
  loadAiSearchSessionContext,
} from "@/lib/services/ai-search/sessions"
import { retrieveHybridResults } from "@/lib/services/ai-search/retrieval"
import {
  resolveProjectFromHints,
  type ProjectRef,
} from "@/lib/services/ai-search/projects"
import {
  clampLimit,
  detectCanonicalMetricIntent,
  detectDrawPaymentStatusIntent,
  detectEntityAttributeIntent,
  extractRetrievalQuery,
  extractSessionMemoryFacts,
  isAssistantRuntimeInfoQuery,
  isGreetingOrSmallTalkQuery,
  isLikelyGeneralNonOrgQuery,
  MEMORY_FACT_LIMIT,
  normalizeQuery,
  pickEntityTypesForQuery,
  planActionWorkflowWithLlm,
  pruneAiPlannerCache,
  requiresClarification,
  resolveAssistantMode,
  buildGreetingResponse,
  type AnalysisIntent,
} from "@/lib/services/ai-search/planning"
import { buildTextSearchOrCondition } from "@/lib/services/ai-search/sql"
import type { StructuredIntent } from "@/lib/services/ai-search/structured"
import { emitTrace, recordAiSearchEvent } from "@/lib/services/ai-search/telemetry"
import {
  planAiWorkflowFromQuery,
  startAiWorkflow,
  type AiWorkflowSession,
} from "@/lib/services/ai-search/workflows"
import { getAiSearchRuntimeFlags, type AiSearchRuntimeFlags } from "@/lib/services/ai-search-flags"
import { executeAiToolInvocation, planAiToolInvocation } from "@/lib/services/ai-search/tools"
import { requireOrgContext } from "@/lib/services/context"
import type { SearchEntityType, SearchResult } from "@/lib/services/search"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export { getAiSearchArtifactDataset } from "@/lib/services/ai-search/artifacts"

export interface AiSearchCitation {
  sourceId: string
  id: string
  type: SearchEntityType
  title: string
  href: string
  subtitle?: string
  projectName?: string
  updatedAt?: string
}

export interface AiSearchRelatedResult {
  id: string
  type: SearchEntityType
  title: string
  href: string
  subtitle?: string
  description?: string
  projectName?: string
  updatedAt?: string
}

export type AiArtifactValue = string | number | null

export type AiChartType = "bar" | "horizontalBar" | "line" | "area" | "pie" | "donut" | "stackedBar"

export const AI_CHART_TYPES: AiChartType[] = ["bar", "horizontalBar", "line", "area", "pie", "donut", "stackedBar"]

export interface AiChartPoint {
  label: string
  value: number
}

// One measured dimension in a multi-series chart (stacked bar / multi-line).
export interface AiChartSeries {
  key: string
  label: string
}

export interface AiSearchArtifact {
  kind: "table" | "chart"
  datasetId: string
  title: string
  table?: {
    columns: string[]
    rows: AiArtifactValue[][]
  }
  chart?: {
    type: AiChartType
    // Single-series charts populate `points`. Multi-series charts (stackedBar,
    // multi-line) populate `series` + `data` instead, where each data row is
    // keyed by `label` plus one numeric value per series key.
    points: AiChartPoint[]
    series?: AiChartSeries[]
    data?: Array<Record<string, AiArtifactValue>>
    valuePrefix?: string
    valueSuffix?: string
  }
}

export interface AiSearchExportLink {
  format: "csv" | "pdf"
  href: string
  label: string
}

export interface AiSearchTraceEvent {
  id: string
  status: "started" | "running" | "completed" | "warning"
  label: string
  detail?: string
  thought?: string
  timestamp: string
}

export interface AskAiSearchResponse {
  answer: string
  citations: AiSearchCitation[]
  relatedResults: AiSearchRelatedResult[]
  generatedAt: string
  assistantMode: "org" | "general"
  mode: "llm" | "fallback"
  provider?: AiProvider
  model?: string
  configSource?: "org" | "platform" | "env" | "default"
  confidence?: "low" | "medium" | "high"
  missingData?: string[]
  artifact?: AiSearchArtifact
  exports?: AiSearchExportLink[]
  actions?: AiSearchAction[]
  workflow?: AiWorkflowSession
  sessionId?: string
}

interface AskAiSearchOptions {
  limit?: number
  onTrace?: (event: AiSearchTraceEvent) => void | Promise<void>
  sessionId?: string
  mode?: "org" | "general"
  currentProjectId?: string | null
}

type RetrievedSource = {
  sourceId: string
  result: SearchResult
}

export type AiSearchArtifactDataset = {
  id: string
  orgId: string
  title: string
  columns: string[]
  rows: AiArtifactValue[][]
  createdAt: string
}

const DEFAULT_LIMIT = 20
const MAX_CONTEXT_SOURCES = 12
const CACHE_TTL_MS = 90_000
const REQUIRE_LLM_FOR_AI_SEARCH = (() => {
  const raw = process.env.AI_SEARCH_REQUIRE_LLM?.trim().toLowerCase()
  if (!raw) return true
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return true
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false
  return true
})()
const AI_SEARCH_CACHE_VERSION = "2026-06-16-action-router-draw-status-v1"
const MAX_QUERY_LENGTH_CHARS = 1_200
const aiAnswerCache = new Map<string, { expiresAt: number; response: AskAiSearchResponse }>()
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

async function executeAnalysisToolLayer(
  intent: AnalysisIntent,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  options: { enableHybridRetrieval?: boolean } = {},
) {
  const enableHybridRetrieval = options.enableHybridRetrieval === true
  const resolvedProject = await resolveProjectFromHints(context, intent.projectName, intent.textQuery)
  const filters: { projectId?: string; status?: string[] } = {}
  if (resolvedProject?.id) {
    filters.projectId = resolvedProject.id
  }

  if (intent.statuses.length > 0 && intent.entityTypes.length === 1 && ENTITY_STATUS_VALUES[intent.entityTypes[0]]) {
    filters.status = intent.statuses
  }

  const queryText = intent.textQuery || extractRetrievalQuery(intent.projectName ?? "")
  const rawResults = await retrieveHybridResults({
    context,
    query: queryText,
    entityTypes: intent.entityTypes,
    filters,
    limit: intent.limit,
    enableHybrid: enableHybridRetrieval,
  })
  const relatedResults = dedupeResults(rawResults).slice(0, intent.limit)
  const financialRollup = intent.includeFinancialRollup ? await loadFinancialRollup({ context, project: resolvedProject ?? undefined }) : null

  return {
    project: resolvedProject,
    relatedResults,
    financialRollup,
  }
}

function formatSourceContext(sources: RetrievedSource[]) {
  return sources
    .map(({ sourceId, result }) => {
      const lines = [
        `[${sourceId}]`,
        `Type: ${formatEntityType(result.type)}`,
        `Title: ${result.title}`,
      ]

      if (result.subtitle) lines.push(`Subtitle: ${result.subtitle}`)
      if (result.description) lines.push(`Description: ${result.description}`)
      if (result.project_name) lines.push(`Project: ${result.project_name}`)
      if (result.updated_at) lines.push(`Updated: ${result.updated_at}`)
      lines.push(`Href: ${result.href}`)

      return lines.join("\n")
    })
    .join("\n\n")
}

function buildFallbackAnswer(query: string, relatedResults: SearchResult[]) {
  if (relatedResults.length === 0) {
    if (isGreetingOrSmallTalkQuery(query)) {
      return buildGreetingResponse(query)
    }
    if (isLikelyGeneralNonOrgQuery(query)) {
      return `I did not find company records for "${query}". If this is a general question, I can answer it directly. If it is company-related, include terms like invoice, project, task, or approval.`
    }
    return `I could not find matching records for "${query}" in your current org context. Try adding a project name, document number, or entity type like "invoice" or "RFI".`
  }

  const typeCounts = new Map<string, number>()
  for (const item of relatedResults) {
    const label = formatEntityType(item.type)
    typeCounts.set(label, (typeCounts.get(label) ?? 0) + 1)
  }

  const topTypes = Array.from(typeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, count]) => `${count} ${label}${count > 1 ? "s" : ""}`)
    .join(", ")

  const highlights = relatedResults
    .slice(0, 3)
    .map((item) => (item.project_name ? `${item.title} (${item.project_name})` : item.title))
    .join("; ")

  return `I found ${relatedResults.length} matching records for "${query}". Most relevant: ${topTypes}. Top matches: ${highlights}.`
}

function buildLlmUnavailableResponse({
  nowIso,
  assistantMode,
  provider,
  model,
  configSource,
}: {
  nowIso: string
  assistantMode: "org" | "general"
  provider: AiProvider
  model: string
  configSource?: "org" | "platform" | "env" | "default"
}): AskAiSearchResponse {
  return {
    answer: "I couldn't reach the configured LLM, so I did not generate a fallback answer. Please restart the model endpoint and try again.",
    citations: [],
    relatedResults: [],
    generatedAt: nowIso,
    assistantMode,
    mode: "fallback",
    provider,
    model,
    configSource,
    confidence: "low",
    missingData: ["Configured LLM was unavailable or timed out. Deterministic fallback is disabled."],
  }
}

function mapRelatedResult(result: SearchResult): AiSearchRelatedResult {
  return {
    id: result.id,
    type: result.type,
    title: result.title,
    href: result.href,
    subtitle: result.subtitle,
    description: result.description,
    projectName: result.project_name,
    updatedAt: result.updated_at,
  }
}

function mapCitation(source: RetrievedSource): AiSearchCitation {
  return {
    sourceId: source.sourceId,
    id: source.result.id,
    type: source.result.type,
    title: source.result.title,
    href: source.result.href,
    subtitle: source.result.subtitle,
    projectName: source.result.project_name,
    updatedAt: source.result.updated_at,
  }
}

function pruneCache() {
  const now = Date.now()
  for (const [key, value] of aiAnswerCache.entries()) {
    if (value.expiresAt <= now) {
      aiAnswerCache.delete(key)
    }
  }

  pruneAiPlannerCache(now)
}

export async function askAiSearch(query: string, options: AskAiSearchOptions = {}): Promise<AskAiSearchResponse> {
  const normalizedQuery = normalizeQuery(query)
  const nowIso = new Date().toISOString()
  const startedAt = Date.now()
  await emitTrace(options, {
    id: "receive-question",
    status: "started",
    label: "Reading your request",
    detail: "I am parsing intent, scope, and the entities we should query.",
    thought: "Reading your request and deciding the best query path.",
  })

  if (!normalizedQuery) {
    await emitTrace(options, {
      id: "empty-question",
      status: "warning",
      label: "No question detected",
      detail: "I need a written question before I can run org-scoped retrieval.",
      thought: "I need a question to continue.",
    })
    return {
      answer: "Ask a question about projects, tasks, files, invoices, or contacts in your org.",
      citations: [],
      relatedResults: [],
      generatedAt: nowIso,
      assistantMode: "org",
      mode: "fallback",
      confidence: "low",
      missingData: ["No question was provided."],
    }
  }

  if (normalizedQuery.length > MAX_QUERY_LENGTH_CHARS) {
    await emitTrace(options, {
      id: "query-too-long",
      status: "warning",
      label: "Question too long",
      detail: `Keep the question under ${MAX_QUERY_LENGTH_CHARS} characters.`,
      thought: "The query is too long for reliable planning. Asking for a shorter prompt.",
    })
    return {
      answer: `Your question is too long (${normalizedQuery.length} characters). Please shorten it to ${MAX_QUERY_LENGTH_CHARS} characters or less and include the key entities or timeframe.`,
      citations: [],
      relatedResults: [],
      generatedAt: nowIso,
      assistantMode: "org",
      mode: "fallback",
      confidence: "low",
      missingData: ["Query exceeded maximum supported length."],
    }
  }

  const context = await requireOrgContext()
  const { orgId, supabase, userId } = context
  const [aiConfig, runtimeFlags] = await Promise.all([
    getOrgAiSearchConfigFromContext(context),
    getAiSearchRuntimeFlags(context),
  ])
  if (!runtimeFlags.enabled) {
    throw new Error("AI search is turned off for this organization.")
  }
  const assistantRuntimeInfoQuery = isAssistantRuntimeInfoQuery(normalizedQuery)
  const assistantMode = assistantRuntimeInfoQuery
    ? "general"
    : await resolveAssistantMode(options.mode, runtimeFlags, normalizedQuery, aiConfig.provider, aiConfig.model)
  const limit = clampLimit(options.limit)
  const sessionId = await ensureAiSearchSession(context, assistantMode, options.sessionId)
  const sessionContext = runtimeFlags.conversationMemory
    ? await loadAiSearchSessionContext({ context, sessionId, memoryFactLimit: MEMORY_FACT_LIMIT })
    : ""
  const memoryFacts = runtimeFlags.conversationMemory ? extractSessionMemoryFacts(normalizedQuery) : []
  const plannerQuery = sessionContext ? `${sessionContext}\nUSER: ${normalizedQuery}` : normalizedQuery
  const cacheKey = `${AI_SEARCH_CACHE_VERSION}:${orgId}:${sessionId}:${assistantMode}:${options.currentProjectId ?? "no-page-project"}:${aiConfig.provider}:${aiConfig.model}:${runtimeFlags.hybridRetrieval ? "hybrid" : "lexical"}:${normalizedQuery.toLowerCase()}:${limit}`
  const sessionContextBlock = sessionContext ? `Conversation context:\n${sessionContext}` : ""
  await emitTrace(options, {
    id: "resolve-context",
    status: "completed",
    label: "Org context secured",
    detail:
      assistantMode === "org"
        ? "All data access is now constrained to your organization."
        : "Non-org response mode is active, so answers are not grounded in org citations.",
    thought:
      assistantMode === "org"
        ? "Org scope is locked, so I will only query your company records."
        : "Non-org mode is active; response quality will rely on model knowledge instead of company data.",
  })
  if (memoryFacts.length > 0) {
    await emitTrace(options, {
      id: "memory-context",
      status: "completed",
      label: "Loaded conversation memory",
      detail: `Using ${memoryFacts.length} persisted memory facts to interpret follow-ups.`,
      thought: "Loaded prior context so follow-up wording can stay natural.",
    })
  }

  pruneCache()
  const cached = aiAnswerCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    if (runtimeFlags.conversationMemory) {
      await appendAiSearchMessage(context, sessionId, "user", normalizedQuery, {
        assistantMode,
        memoryFacts,
      })
      await appendAiSearchMessage(context, sessionId, "assistant", cached.response.answer, {
        mode: cached.response.mode,
        provider: cached.response.provider,
        model: cached.response.model,
        cached: true,
        assistantMode,
      })
    }
    await emitTrace(options, {
      id: "cache-hit",
      status: "completed",
      label: "Using cached answer",
      detail: "Returning recent result for this question.",
    })
    await emitTrace(options, {
      id: "done",
      status: "completed",
      label: "Answer ready",
      detail: "Served from cache.",
    })
    await recordAiSearchEvent({
      context,
      sessionId,
      query: normalizedQuery,
      assistantMode,
      success: true,
      plan: { cache: true },
      metrics: { cache_hit: true, planner_v2: runtimeFlags.plannerV2 },
      citationsCount: cached.response.citations.length,
      resultsCount: cached.response.relatedResults.length,
      latencyMs: Date.now() - startedAt,
    })
    return {
      ...cached.response,
      assistantMode: cached.response.assistantMode ?? assistantMode,
      actions: cached.response.actions ?? [],
      sessionId,
    }
  }

  if (runtimeFlags.conversationMemory) {
    await appendAiSearchMessage(context, sessionId, "user", normalizedQuery, {
      assistantMode,
      memoryFacts,
    })
  }

  const finalizeResponse = async (
    response: AskAiSearchResponse,
    meta: {
      success?: boolean
      error?: string
      plan?: Record<string, unknown>
      metrics?: Record<string, unknown>
    } = {},
  ): Promise<AskAiSearchResponse> => {
    const resolvedAssistantMode = response.assistantMode === "general" || response.assistantMode === "org" ? response.assistantMode : assistantMode
    const withSession: AskAiSearchResponse = {
      ...response,
      assistantMode: resolvedAssistantMode,
      confidence:
        response.confidence ??
        inferConfidenceFromResponse({
          rowCount: response.relatedResults.length,
          citationsCount: response.citations.length,
          fallback: "low",
        }),
      missingData: response.missingData ?? [],
      actions: response.actions ?? [],
      sessionId,
    }
    if (!withSession.workflow) {
      aiAnswerCache.set(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        response: withSession,
      })
    }
    if (runtimeFlags.conversationMemory) {
      await appendAiSearchMessage(context, sessionId, "assistant", withSession.answer, {
        mode: withSession.mode,
        provider: withSession.provider,
        model: withSession.model,
        assistantMode: resolvedAssistantMode,
      })
    }
    await recordAiSearchEvent({
      context,
      sessionId,
      query: normalizedQuery,
      assistantMode: resolvedAssistantMode,
      success: meta.success ?? true,
      error: meta.error,
      plan: meta.plan,
      metrics: {
        planner_v2: runtimeFlags.plannerV2,
        hybrid_retrieval: runtimeFlags.hybridRetrieval,
        conversation_memory: runtimeFlags.conversationMemory,
        ...(meta.metrics ?? {}),
      },
      citationsCount: withSession.citations.length,
      resultsCount: withSession.relatedResults.length,
      latencyMs: Date.now() - startedAt,
    })
    return withSession
  }

  const finalizeLlmUnavailable = async (
    detail: string,
    meta: {
      plan?: Record<string, unknown>
      metrics?: Record<string, unknown>
    } = {},
  ) => {
    await emitTrace(options, {
      id: "llm-required",
      status: "warning",
      label: "LLM unavailable",
      detail,
      thought: "Model call failed, and deterministic fallback is disabled.",
    })
    return finalizeResponse(
      buildLlmUnavailableResponse({
        nowIso,
        assistantMode,
        provider: aiConfig.provider,
        model: aiConfig.model,
        configSource: aiConfig.source,
      }),
      {
        success: false,
        error: "llm_unavailable",
        plan: meta.plan,
        metrics: {
          llm_required: REQUIRE_LLM_FOR_AI_SEARCH,
          llm_unavailable: true,
          ...(meta.metrics ?? {}),
        },
      },
    )
  }

  if (isGreetingOrSmallTalkQuery(normalizedQuery)) {
    await emitTrace(options, {
      id: "social-intent",
      status: "completed",
      label: "Greeting detected",
      detail: "Responding conversationally without running org data retrieval.",
      thought: "This is a conversational prompt, so I will respond directly.",
    })

    return finalizeResponse(
      {
        answer: buildGreetingResponse(normalizedQuery),
        citations: [],
        relatedResults: [],
        generatedAt: nowIso,
        assistantMode,
        mode: "fallback",
        provider: aiConfig.provider,
        model: aiConfig.model,
        configSource: aiConfig.source,
        confidence: "high",
        missingData: [],
      },
      {
        plan: { social_intent: true },
        metrics: { social_intent: true },
      },
    )
  }

  if (assistantRuntimeInfoQuery) {
    const openAiBaseUrl = aiConfig.provider === "openai" ? getOpenAiBaseUrl() : undefined
    const endpointNote = openAiBaseUrl
      ? ` via the OpenAI-compatible endpoint at ${openAiBaseUrl}`
      : ""
    const sourceNote =
      aiConfig.source === "org"
        ? "This setting is coming from your org override."
        : aiConfig.source === "platform"
          ? "This setting is coming from the platform default."
          : aiConfig.source === "env"
            ? "This setting is coming from local environment defaults."
            : "This is the built-in default configuration."

    await emitTrace(options, {
      id: "assistant-runtime-info",
      status: "completed",
      label: "Resolved assistant runtime",
      detail: "Answered directly from the active AI configuration without querying org data.",
      thought: "This is a question about the assistant itself, so I can answer from config immediately.",
    })

    return finalizeResponse(
      {
        answer: `This chat is currently configured to use the ${aiConfig.provider} provider with the model "${aiConfig.model}"${endpointNote}. ${sourceNote}`,
        citations: [],
        relatedResults: [],
        generatedAt: nowIso,
        assistantMode: "general",
        mode: "fallback",
        provider: aiConfig.provider,
        model: aiConfig.model,
        configSource: aiConfig.source,
        confidence: "high",
        missingData: ["This answer is based on runtime configuration, not org records."],
      },
      {
        plan: { mode: "general", runtime_info: true },
        metrics: { runtime_info: true },
      },
    )
  }

  const clarification = requiresClarification({
    query: normalizedQuery,
    mode: assistantMode,
    sessionContext,
  })
  if (clarification) {
    await emitTrace(options, {
      id: "clarification-needed",
      status: "warning",
      label: "Need more context",
      detail: "Asking a clarifying follow-up before running tools.",
    })

    return finalizeResponse(
      {
        answer: clarification,
        citations: [],
        relatedResults: [],
        generatedAt: nowIso,
        assistantMode,
        mode: "fallback",
        provider: aiConfig.provider,
        model: aiConfig.model,
        configSource: aiConfig.source,
        confidence: "low",
        missingData: ["Scope or time range was ambiguous."],
      },
      {
        plan: { clarification: true },
        metrics: { clarification: true },
      },
    )
  }

  if (assistantMode === "general") {
    await emitTrace(options, {
      id: "general-assistant",
      status: "running",
      label: "Running general response",
      detail: "Using non-org reasoning without company-record citations.",
    })

    const generalAnswer = await generateGeneralAssistantAnswer({
      query: normalizedQuery,
      provider: aiConfig.provider,
      model: aiConfig.model,
      sessionContext: runtimeFlags.conversationMemory ? sessionContext : undefined,
    })

    if (REQUIRE_LLM_FOR_AI_SEARCH && !generalAnswer) {
      return finalizeLlmUnavailable("General model generation failed or timed out.", {
        plan: { mode: "general" },
        metrics: { general_mode: true },
      })
    }

    await emitTrace(options, {
      id: "done",
      status: "completed",
      label: "Answer ready",
      detail: generalAnswer ? "Generated by model synthesis." : "Returned compatibility fallback.",
    })

    return finalizeResponse(
      {
        answer:
          generalAnswer?.answer ??
          "I could not generate a general answer right now. Try again, or ask a company-data question.",
        citations: [],
        relatedResults: [],
        generatedAt: nowIso,
        assistantMode,
        mode: generalAnswer ? "llm" : "fallback",
        provider: generalAnswer?.provider ?? aiConfig.provider,
        model: generalAnswer?.model ?? aiConfig.model,
        configSource: aiConfig.source,
        confidence: generalAnswer ? "medium" : "low",
        missingData: ["This response path is not grounded in company records."],
      },
      {
        plan: { mode: "general" },
        metrics: { general_mode: true },
      },
    )
  }

  if (!REQUIRE_LLM_FOR_AI_SEARCH && assistantMode === "org") {
    const attributeIntent = detectEntityAttributeIntent(normalizedQuery)
    if (attributeIntent) {
      await emitTrace(options, {
        id: "attribute-lookup",
        status: "running",
        label: "Resolving field lookup",
        detail: "Locating the requested record and reading the exact field value.",
        thought: "Running deterministic field lookup before broad retrieval.",
      })

      const attributeExecution = await executeEntityAttributeLookupIntent(attributeIntent, normalizedQuery, context)
      const sources: RetrievedSource[] = attributeExecution.relatedResult
        ? [{ sourceId: "S1", result: attributeExecution.relatedResult }]
        : []
      const citations = sources.map(mapCitation)

      await emitTrace(options, {
        id: "done",
        status: attributeExecution.missingData.length > 0 ? "warning" : "completed",
        label: "Answer ready",
        detail:
          attributeExecution.missingData.length > 0
            ? "Field lookup completed with missing data."
            : "Field lookup completed successfully.",
        thought:
          attributeExecution.missingData.length > 0
            ? "Field lookup ran, but the requested value was missing or ambiguous."
            : "Field lookup produced a deterministic answer.",
      })

      return finalizeResponse(
        {
          answer: attributeExecution.answer,
          citations,
          relatedResults: attributeExecution.relatedResult ? [mapRelatedResult(attributeExecution.relatedResult)] : [],
          generatedAt: nowIso,
          assistantMode,
          mode: "fallback",
          provider: aiConfig.provider,
          model: aiConfig.model,
          configSource: aiConfig.source,
          confidence: attributeExecution.confidence,
          missingData: attributeExecution.missingData,
        },
        {
          plan: {
            planner: "entity_attribute_lookup",
            entity: attributeIntent.entityType,
            field: attributeIntent.fieldKey,
          },
          metrics: {
            attribute_lookup: true,
            has_result: Boolean(attributeExecution.relatedResult),
          },
        },
      )
    }
  }

  const drawPaymentStatusIntent = detectDrawPaymentStatusIntent(normalizedQuery, limit, options.currentProjectId)
  if (assistantMode === "org" && drawPaymentStatusIntent) {
    await emitTrace(options, {
      id: "draw-payment-status",
      status: "running",
      label: "Checking draw payment status",
      detail: "Reading draw schedule, linked invoices, and payments.",
      thought: "This is a payment status question, so I will answer from financial records directly.",
    })

    const drawExecution = await executeDrawPaymentStatusIntent(drawPaymentStatusIntent, context)
    const sources: RetrievedSource[] = drawExecution.relatedResults
      .slice(0, MAX_CONTEXT_SOURCES)
      .map((result, index) => ({
        sourceId: `S${index + 1}`,
        result,
      }))
    const citations = sources.map(mapCitation)

    await emitTrace(options, {
      id: "done",
      status: drawExecution.missingData.length > 0 ? "warning" : "completed",
      label: "Answer ready",
      detail: "Delivered from draw payment status pipeline.",
      thought: "Draw payment status response is ready.",
    })

    return finalizeResponse(
      {
        answer: drawExecution.summary,
        citations,
        relatedResults: drawExecution.relatedResults.slice(0, 8).map(mapRelatedResult),
        generatedAt: nowIso,
        assistantMode,
        mode: "fallback",
        provider: aiConfig.provider,
        model: aiConfig.model,
        configSource: aiConfig.source,
        confidence: drawExecution.confidence,
        missingData: drawExecution.missingData,
        artifact: drawExecution.artifactData.artifact,
        exports: drawExecution.artifactData.exports,
      },
      {
        plan: {
          planner: "draw_payment_status",
          project: drawPaymentStatusIntent.projectName ?? drawPaymentStatusIntent.projectId ?? null,
          drawNumbers: drawPaymentStatusIntent.drawNumbers,
        },
        metrics: {
          draw_payment_status: true,
          rows_scanned: drawExecution.rowCount,
        },
      },
    )
  }

  const canonicalMetricIntent = detectCanonicalMetricIntent(normalizedQuery, limit)
  if (!REQUIRE_LLM_FOR_AI_SEARCH && assistantMode === "org" && canonicalMetricIntent) {
    await emitTrace(options, {
      id: "canonical-metric",
      status: "running",
      label: "Running canonical metric tool",
      detail: `${canonicalMetricIntent.label} (${canonicalMetricIntent.key})`,
      thought: "Routing to canonical metrics for a reliable business answer.",
    })

    const canonicalExecution = await executeCanonicalMetricIntent(canonicalMetricIntent, context, {
      enableHybridRetrieval: runtimeFlags.hybridRetrieval,
    })
    const relatedResults = canonicalExecution.relatedResults
    const sources: RetrievedSource[] = relatedResults
      .slice(0, MAX_CONTEXT_SOURCES)
      .map((result, index) => ({
        sourceId: `S${index + 1}`,
        result,
      }))
    const canonicalContext = [
      canonicalExecution.additionalContext,
      `Canonical metric: ${canonicalMetricIntent.key}`,
      canonicalMetricIntent.projectName ? `Project hint: ${canonicalMetricIntent.projectName}` : "",
      canonicalMetricIntent.dateRangeDays ? `Date range days: ${canonicalMetricIntent.dateRangeDays}` : "",
    ]
      .filter((line) => line.trim().length > 0)
      .join("\n")

    const llmAnswer = await generateAnswerWithLlm(
      normalizedQuery,
      sources,
      aiConfig.provider,
      aiConfig.model,
      [sessionContextBlock, canonicalContext].filter((line) => line.trim().length > 0).join("\n\n") || undefined,
    )
    if (REQUIRE_LLM_FOR_AI_SEARCH && !llmAnswer) {
      return finalizeLlmUnavailable("Canonical metric synthesis failed or timed out.", {
        plan: {
          planner: "canonical_metric",
          metric: canonicalMetricIntent.key,
          project: canonicalMetricIntent.projectName ?? null,
          groupBy: canonicalMetricIntent.groupBy,
        },
        metrics: {
          canonical_metric: canonicalMetricIntent.key,
          rows_scanned: canonicalExecution.rowCount,
        },
      })
    }

    const verification = verifyGroundedAnswer({
      llmAnswer,
      sources,
      fallbackAnswer: canonicalExecution.summary,
      rowCount: canonicalExecution.rowCount,
      baseConfidence: canonicalExecution.confidence,
      missingData: canonicalExecution.missingData,
    })
    const citations = resolveCitations(sources, verification.citationIds).map(mapCitation)

    await emitTrace(options, {
      id: "canonical-verify",
      status: verification.downgradedToFallback ? "warning" : "completed",
      label: "Verification complete",
      detail: verification.downgradedToFallback
        ? "Model output was corrected to grounded deterministic summary."
        : "Model output passed grounding checks.",
      thought: verification.notes[0] ?? "Grounding and citation checks completed.",
    })

    await emitTrace(options, {
      id: "done",
      status: "completed",
      label: "Answer ready",
      detail: "Delivered from canonical metric pipeline.",
      thought: "Canonical metric response is ready.",
    })

    return finalizeResponse(
      {
        answer: verification.answer,
        citations,
        relatedResults: relatedResults.slice(0, 8).map(mapRelatedResult),
        generatedAt: nowIso,
        assistantMode,
        mode: llmAnswer && !verification.downgradedToFallback ? "llm" : "fallback",
        provider: llmAnswer?.provider ?? aiConfig.provider,
        model: llmAnswer?.model ?? aiConfig.model,
        configSource: aiConfig.source,
        confidence: verification.confidence,
        missingData: verification.missingData,
        artifact: canonicalExecution.artifactData.artifact,
        exports: canonicalExecution.artifactData.exports,
      },
      {
        plan: {
          planner: "canonical_metric",
          metric: canonicalMetricIntent.key,
          project: canonicalMetricIntent.projectName ?? null,
          groupBy: canonicalMetricIntent.groupBy,
        },
        metrics: {
          canonical_metric: canonicalMetricIntent.key,
          rows_scanned: canonicalExecution.rowCount,
          verification_downgraded: verification.downgradedToFallback,
        },
      },
    )
  }

  const llmMappedWorkflow =
    assistantMode === "org"
      ? await planActionWorkflowWithLlm({
          query: normalizedQuery,
          provider: aiConfig.provider,
          model: aiConfig.model,
          currentProjectId: options.currentProjectId,
        })
      : null
  const mappedWorkflow =
    llmMappedWorkflow && llmMappedWorkflow.confidence >= 0.75
      ? llmMappedWorkflow
      : planAiWorkflowFromQuery(normalizedQuery, {
          currentProjectId: options.currentProjectId,
        })
  if (mappedWorkflow && mappedWorkflow.confidence >= 0.8) {
    try {
      await emitTrace(options, {
        id: "workflow-router",
        status: "running",
        label: "Starting guided workflow",
        detail: `${mappedWorkflow.workflowKey} (${Math.round(mappedWorkflow.confidence * 100)}% confidence).`,
        thought: `This request needs a multi-step workflow, so I am starting ${mappedWorkflow.workflowKey}.`,
      })

      const { workflow, answer } = await startAiWorkflow(context, {
        workflowKey: mappedWorkflow.workflowKey,
        sessionId,
        slots: mappedWorkflow.slots,
      })

      await emitTrace(options, {
        id: "workflow-ready",
        status: "completed",
        label: workflow.status === "preview_ready" ? "Workflow preview ready" : "Workflow question ready",
        detail: workflow.status === "preview_ready" ? "Review the invoice preview before creating it." : workflow.questions[0]?.label,
        thought: "The workflow state is saved and ready for the next user response.",
      })

      return finalizeResponse(
        {
          answer,
          citations: [],
          relatedResults: [],
          generatedAt: nowIso,
          assistantMode,
          mode: "fallback",
          provider: aiConfig.provider,
          model: aiConfig.model,
          configSource: aiConfig.source,
          confidence: "high",
          missingData: workflow.missingSlots,
          actions: [],
          workflow,
        },
        {
          plan: {
            planner: "workflow_router",
            workflow: mappedWorkflow.workflowKey,
            confidence: mappedWorkflow.confidence,
          },
          metrics: {
            workflow_started: true,
          },
        },
      )
    } catch (error) {
      await emitTrace(options, {
        id: "workflow-start-failed",
        status: "warning",
        label: "Workflow unavailable",
        detail: error instanceof Error ? error.message : "Unable to start workflow.",
        thought: "Workflow startup failed. Falling back to regular AI search.",
      })
    }
  }

  const mappedTool = planAiToolInvocation(normalizedQuery)
  const shouldRunToolShortcut = Boolean(
    mappedTool &&
      mappedTool.confidence >= 0.8 &&
      (isAiActionToolKey(mappedTool.toolKey) || mappedTool.toolKey === "records.search"),
  )
  if (!REQUIRE_LLM_FOR_AI_SEARCH && mappedTool && shouldRunToolShortcut) {
    await emitTrace(options, {
      id: "tool-router",
      status: "running",
      label: "Selecting best tool",
      detail: `${mappedTool.toolKey} (${Math.round(mappedTool.confidence * 100)}% confidence).`,
      thought: `This request maps best to ${mappedTool.toolKey}, so I am using that path first.`,
    })

    if (isAiActionToolKey(mappedTool.toolKey)) {
      try {
        const actionDraft = buildAiActionDraft(mappedTool.toolKey, mappedTool.args)
        if (actionDraft) {
          await emitTrace(options, {
            id: "action-proposal",
            status: "running",
            label: "Drafting action request",
            detail: "Creating a pending action that requires your approval before execution.",
            thought: "Drafting an executable action and holding it for your approval.",
          })

          const action = await createAiSearchActionRequest(context, {
            sessionId,
            toolKey: mappedTool.toolKey,
            title: actionDraft.title,
            summary: actionDraft.summary,
            args: actionDraft.args,
            requiresApproval: actionDraft.requiresApproval,
          })

          await emitTrace(options, {
            id: "done",
            status: "completed",
            label: "Action draft ready",
            detail: "I prepared the action. It will run only after you approve it.",
            thought: "Action draft is ready. Waiting for your approval.",
          })

          return finalizeResponse(
            {
              answer: "I drafted an action for you. Review it below and click Execute when you want it to run.",
              citations: [],
              relatedResults: [],
              generatedAt: nowIso,
              assistantMode,
              mode: "fallback",
              provider: aiConfig.provider,
              model: aiConfig.model,
              configSource: aiConfig.source,
              confidence: "high",
              missingData: [],
              actions: [action],
            },
            {
              plan: {
                planner: "tool_router",
                tool: mappedTool.toolKey,
                reason: mappedTool.reason,
                confidence: mappedTool.confidence,
                action_proposed: true,
              },
              metrics: {
                action_proposed: true,
              },
            },
          )
        }
      } catch (error) {
        await emitTrace(options, {
          id: "action-proposal-failed",
          status: "warning",
          label: "Action draft failed",
          detail: "I could not create an action draft, so I am switching to read-only planning.",
          thought: "Action draft failed. Falling back to read-only analysis.",
        })
        console.error("Action proposal failed", error)
      }
    }

    try {
      const toolExecution = await executeAiToolInvocation(context, mappedTool)
      if (toolExecution) {
        await emitTrace(options, {
          id: "tool-run",
          status: "completed",
          label: "Tool execution complete",
          detail: `${toolExecution.rows.toLocaleString()} rows processed.`,
          thought: `Tool run complete with ${toolExecution.rows.toLocaleString()} matching rows.`,
        })

        const relatedResults = dedupeResults(toolExecution.relatedResults).slice(0, Math.max(limit, 12))
        const sources: RetrievedSource[] = relatedResults
          .slice(0, MAX_CONTEXT_SOURCES)
          .map((result, index) => ({
            sourceId: `S${index + 1}`,
            result,
          }))

        if (
          assistantMode === "org" && toolExecution.rows === 0 && isLikelyGeneralNonOrgQuery(normalizedQuery)
        ) {
          await emitTrace(options, {
            id: "general-rescue",
            status: "running",
            label: "Switching to general reasoning",
            detail: "Tool execution returned no org rows. Generating a direct general answer.",
            thought: "Tool path had no org evidence, so switching to general fallback.",
          })

          const generalAnswer = await generateGeneralAssistantAnswer({
            query: normalizedQuery,
            provider: aiConfig.provider,
            model: aiConfig.model,
            sessionContext: runtimeFlags.conversationMemory ? sessionContext : undefined,
          })

          if (generalAnswer) {
            await emitTrace(options, {
              id: "done",
              status: "completed",
              label: "Answer ready",
              detail: "Returned from general-assistant fallback.",
              thought: "General fallback succeeded after zero-row tool output.",
            })

            return finalizeResponse(
              {
                answer: generalAnswer.answer,
                citations: [],
                relatedResults: [],
                generatedAt: nowIso,
                assistantMode: "general",
                mode: "llm",
                provider: generalAnswer.provider,
                model: generalAnswer.model,
                configSource: aiConfig.source,
                confidence: "medium",
                missingData: ["No matching org records were found for this query."],
              },
              {
                plan: {
                  planner: "tool_router",
                  tool: mappedTool.toolKey,
                  general_rescue: true,
                },
                metrics: {
                  tool_rows: 0,
                  general_rescue: true,
                },
              },
            )
          }
        }

        const toolContext = [
          `Tool: ${mappedTool.toolKey}`,
          `Reason: ${mappedTool.reason}`,
          `Rows: ${toolExecution.rows}`,
          typeof toolExecution.metric === "number" ? `Metric: ${toolExecution.metric}` : "",
          toolExecution.summary,
        ]
          .filter((line) => line.trim().length > 0)
          .join("\n")

        const llmAnswer = await generateAnswerWithLlm(
          normalizedQuery,
          sources,
          aiConfig.provider,
          aiConfig.model,
          [sessionContextBlock, toolContext].filter((line) => line.trim().length > 0).join("\n\n") || undefined,
        )
        if (REQUIRE_LLM_FOR_AI_SEARCH && !llmAnswer) {
          return finalizeLlmUnavailable("Tool synthesis failed or timed out.", {
            plan: {
              planner: "tool_router",
              tool: mappedTool.toolKey,
              reason: mappedTool.reason,
              confidence: mappedTool.confidence,
            },
            metrics: {
              tool_rows: toolExecution.rows,
              tool_metric: typeof toolExecution.metric === "number" ? toolExecution.metric : null,
            },
          })
        }
        const citations = resolveCitations(sources, llmAnswer?.citationIds ?? []).map(mapCitation)
        const artifactData = buildArtifactForFallback(orgId, relatedResults)
        const response: AskAiSearchResponse = {
          answer: llmAnswer?.answer ?? toolExecution.summary,
          citations,
          relatedResults: relatedResults.slice(0, 8).map(mapRelatedResult),
          generatedAt: nowIso,
          assistantMode,
          mode: llmAnswer ? "llm" : "fallback",
          provider: llmAnswer?.provider ?? aiConfig.provider,
          model: llmAnswer?.model ?? aiConfig.model,
          configSource: aiConfig.source,
          confidence: inferConfidenceFromResponse({
            rowCount: toolExecution.rows,
            citationsCount: citations.length,
            fallback: toolExecution.rows > 0 ? "high" : "low",
          }),
          missingData:
            toolExecution.rows > 0
              ? []
              : ["Tool matched intent but returned no rows in current org scope."],
          artifact: artifactData.artifact,
          exports: artifactData.exports,
        }

        await emitTrace(options, {
          id: "done",
          status: "completed",
          label: "Answer ready",
          detail: "Generated from deterministic tool execution.",
          thought: "Response is ready from deterministic tool output.",
        })

        return finalizeResponse(response, {
          plan: {
            planner: "tool_router",
            tool: mappedTool.toolKey,
            reason: mappedTool.reason,
            confidence: mappedTool.confidence,
          },
          metrics: {
            tool_rows: toolExecution.rows,
            tool_metric: typeof toolExecution.metric === "number" ? toolExecution.metric : null,
          },
        })
      }
    } catch (error) {
      await emitTrace(options, {
        id: "tool-router-failed",
        status: "warning",
        label: "Tool execution fallback",
        detail: "Tool execution failed; continuing with planner path.",
      })
      console.error("Tool-router execution failed", error)
    }
  }

  await emitTrace(options, {
    id: "plan-query",
    status: "running",
    label: "Planning query",
    detail: "Selecting best datasets and query strategy.",
  })
  const plannerLoopResult = runtimeFlags.plannerV2
    ? await runPlannerExecutorLoop({
        normalizedQuery,
        plannerQuery,
        sessionContext,
        provider: aiConfig.provider,
        model: aiConfig.model,
        limit,
        context,
        runtimeFlags,
      })
    : null

  if (runtimeFlags.plannerV2 && plannerLoopResult) {
    const { agentPlan, finalPlan, execution, stepPlans, attempt, plannedFromQuery } = plannerLoopResult
    await emitTrace(options, {
      id: "plan-ready",
      status: "completed",
      label: "Plan ready",
      detail: `${agentPlan.operation} on ${formatEntityType(agentPlan.entityType)} (attempt ${attempt}).`,
      thought: attempt > 1 ? "First plan was weak, so I replanned with adjusted context." : "Planner produced a high-confidence first-pass plan.",
    })
    await emitTrace(options, {
      id: "run-query",
      status: "running",
      label: "Running org-scoped queries",
      detail: "Executing read-only queries with safety guards.",
    })
    await emitTrace(options, {
      id: "query-complete",
      status: "completed",
      label: "Data fetched",
      detail:
        stepPlans.length > 1
          ? `${execution.rowCount.toLocaleString()} records matched across ${stepPlans.length} steps.`
          : `${execution.rowCount.toLocaleString()} records matched after validation.`,
    })
    const relatedResults = execution.relatedResults
    const sources: RetrievedSource[] = relatedResults
      .slice(0, MAX_CONTEXT_SOURCES)
      .map((result, index) => ({
        sourceId: `S${index + 1}`,
        result,
      }))

    const agentContext = [
      execution.additionalContext ?? "",
      `Final plan: operation=${finalPlan.operation}, entity=${finalPlan.entityType}, metric=${finalPlan.metric}, groupBy=${finalPlan.groupBy}`,
      finalPlan.projectName ? `Project hint: ${finalPlan.projectName}` : "",
    ]
      .filter((line) => line.trim().length > 0)
      .join("\n")

    if (
      assistantMode === "org" && relatedResults.length === 0 && isLikelyGeneralNonOrgQuery(normalizedQuery)
    ) {
      await emitTrace(options, {
        id: "general-rescue",
        status: "running",
        label: "Switching to general reasoning",
        detail: "No org records matched the planned query. Generating a direct general answer.",
        thought: "Planner returned no org evidence, so switching to general fallback.",
      })

      const generalAnswer = await generateGeneralAssistantAnswer({
        query: normalizedQuery,
        provider: aiConfig.provider,
        model: aiConfig.model,
        sessionContext: runtimeFlags.conversationMemory ? sessionContext : undefined,
      })

      if (generalAnswer) {
        await emitTrace(options, {
          id: "done",
          status: "completed",
          label: "Answer ready",
          detail: "Returned from general-assistant fallback.",
          thought: "General fallback succeeded after planner returned no records.",
        })

        return finalizeResponse(
          {
            answer: generalAnswer.answer,
            citations: [],
            relatedResults: [],
            generatedAt: nowIso,
            assistantMode: "general",
            mode: "llm",
            provider: generalAnswer.provider,
            model: generalAnswer.model,
            configSource: aiConfig.source,
            confidence: "medium",
            missingData: ["No matching org records were found for this query."],
          },
          {
            plan: {
              planner: "v2_loop",
              general_rescue: true,
              attempts: attempt,
            },
            metrics: {
              rows_scanned: 0,
              general_rescue: true,
            },
          },
        )
      }
    }

    await emitTrace(options, {
      id: "synthesize",
      status: "running",
      label: "Composing response",
      detail: "Summarizing results and preparing citations.",
    })
    const llmAnswer = await generateAnswerWithLlm(
      normalizedQuery,
      sources,
      aiConfig.provider,
      aiConfig.model,
      [sessionContextBlock, agentContext].filter((line) => line.trim().length > 0).join("\n\n") || undefined,
    )
    if (REQUIRE_LLM_FOR_AI_SEARCH && !llmAnswer) {
      return finalizeLlmUnavailable("Planner synthesis failed or timed out.", {
        plan: {
          planner: "v2_loop",
          operation: finalPlan.operation,
          entity: finalPlan.entityType,
          planned_from_query: plannedFromQuery,
          attempts: attempt,
          steps: stepPlans.map((step) => ({
            operation: step.operation,
            entity: step.entityType,
            metric: step.metric,
            groupBy: step.groupBy,
          })),
        },
        metrics: {
          rows_scanned: execution.rowCount,
          step_count: stepPlans.length,
          planner_attempts: attempt,
        },
      })
    }
    const verification = verifyGroundedAnswer({
      llmAnswer,
      sources,
      fallbackAnswer: execution.answerFallback,
      rowCount: execution.rowCount,
      baseConfidence: execution.confidence,
      missingData: execution.missingData,
    })
    const citations = resolveCitations(sources, verification.citationIds).map(mapCitation)
    await emitTrace(options, {
      id: "verify-grounding",
      status: verification.downgradedToFallback ? "warning" : "completed",
      label: "Verifying grounded answer",
      detail: verification.downgradedToFallback
        ? "Model answer was adjusted to deterministic grounded output."
        : "Grounding verification passed.",
      thought: verification.notes[0] ?? "Grounding verification completed.",
    })

    const response: AskAiSearchResponse = {
      answer: verification.answer,
      citations,
      relatedResults: relatedResults.slice(0, 8).map(mapRelatedResult),
      generatedAt: nowIso,
      assistantMode,
      mode: llmAnswer && !verification.downgradedToFallback ? "llm" : "fallback",
      provider: llmAnswer?.provider ?? aiConfig.provider,
      model: llmAnswer?.model ?? aiConfig.model,
      configSource: aiConfig.source,
      confidence: verification.confidence,
      missingData: verification.missingData,
      artifact: execution.artifactData.artifact,
      exports: execution.artifactData.exports,
    }

    await emitTrace(options, {
      id: "done",
      status: "completed",
      label: "Answer ready",
      detail: llmAnswer ? "Generated with model synthesis." : "Generated from deterministic summary.",
    })

    return finalizeResponse(response, {
      plan: {
        planner: "v2_loop",
        operation: finalPlan.operation,
        entity: finalPlan.entityType,
        planned_from_query: plannedFromQuery,
        attempts: attempt,
        steps: stepPlans.map((step) => ({
          operation: step.operation,
          entity: step.entityType,
          metric: step.metric,
          groupBy: step.groupBy,
        })),
      },
      metrics: {
        rows_scanned: execution.rowCount,
        step_count: stepPlans.length,
        planner_attempts: attempt,
        verification_downgraded: verification.downgradedToFallback,
      },
    })
  }

  if (REQUIRE_LLM_FOR_AI_SEARCH && runtimeFlags.plannerV2) {
    return finalizeLlmUnavailable("Planner model was unavailable, so no query plan could be generated.", {
      plan: { planner: "v2_loop", planner_result: "none" },
      metrics: { planner_v2: true, planner_result_none: true },
    })
  }

  await emitTrace(options, {
    id: "planner-no-plan",
    status: "warning",
    label: "Planner could not finalize",
    detail: "I could not produce a reliable v2 plan, so I am switching to grounded retrieval.",
    thought: "Planner confidence was low, so I am falling back to broad grounded retrieval.",
  })

  await emitTrace(options, {
    id: "run-query-fallback",
    status: "running",
    label: "Running broad retrieval",
    detail: "Searching across core entity types in your organization.",
    thought: "Running broad org-scoped retrieval as a safety fallback.",
  })
  const entityTypes = pickEntityTypesForQuery(normalizedQuery)
  const retrievalQuery = extractRetrievalQuery(normalizedQuery)
  const rawResults = await retrieveHybridResults({
    context: { orgId, supabase, userId },
    query: retrievalQuery,
    entityTypes,
    filters: {},
    limit,
    enableHybrid: runtimeFlags.hybridRetrieval,
  })

  const relatedResults = dedupeResults(rawResults).slice(0, limit)
  const sources: RetrievedSource[] = relatedResults
    .slice(0, MAX_CONTEXT_SOURCES)
    .map((result, index) => ({
      sourceId: `S${index + 1}`,
      result,
    }))

  if (
    assistantMode === "org" && relatedResults.length === 0 && isLikelyGeneralNonOrgQuery(normalizedQuery)
  ) {
    await emitTrace(options, {
      id: "general-rescue",
      status: "running",
      label: "Switching to general reasoning",
      detail: "No org records matched. Generating a direct general answer.",
      thought: "No org evidence was found, so switching to general assistance for this query.",
    })

    const generalAnswer = await generateGeneralAssistantAnswer({
      query: normalizedQuery,
      provider: aiConfig.provider,
      model: aiConfig.model,
      sessionContext: runtimeFlags.conversationMemory ? sessionContext : undefined,
    })

    if (generalAnswer) {
      await emitTrace(options, {
        id: "done",
        status: "completed",
        label: "Answer ready",
        detail: "Returned from general-assistant fallback.",
        thought: "General fallback succeeded after org retrieval returned no records.",
      })
      return finalizeResponse(
        {
          answer: generalAnswer.answer,
          citations: [],
          relatedResults: [],
          generatedAt: nowIso,
          assistantMode: "general",
          mode: "llm",
          provider: generalAnswer.provider,
          model: generalAnswer.model,
          configSource: aiConfig.source,
          confidence: "medium",
          missingData: ["No matching org records were found for this query."],
        },
        {
          plan: {
            planner: "v2_retrieval_fallback",
            general_rescue: true,
          },
          metrics: {
            rows_scanned: 0,
            general_rescue: true,
          },
        },
      )
    }
  }

  const llmAnswer = await generateAnswerWithLlm(
    normalizedQuery,
    sources,
    aiConfig.provider,
    aiConfig.model,
    sessionContextBlock || undefined,
  )
  if (REQUIRE_LLM_FOR_AI_SEARCH && !llmAnswer) {
    return finalizeLlmUnavailable("Grounded retrieval synthesis failed or timed out.", {
      plan: {
        planner: "v2_retrieval_fallback",
        entity_types: entityTypes,
      },
      metrics: {
        rows_scanned: relatedResults.length,
      },
    })
  }
  const fallbackAnswer = buildFallbackAnswer(normalizedQuery, relatedResults)
  const verification = verifyGroundedAnswer({
    llmAnswer,
    sources,
    fallbackAnswer,
    rowCount: relatedResults.length,
    baseConfidence: inferConfidenceFromResponse({
      rowCount: relatedResults.length,
      citationsCount: sources.length,
      fallback: relatedResults.length > 0 ? "medium" : "low",
    }),
    missingData:
      relatedResults.length > 0 ? [] : ["No strong matches found. Try adding project, status, or timeframe."],
  })
  const citations = resolveCitations(sources, verification.citationIds).map(mapCitation)
  const artifactData = buildArtifactForFallback(orgId, relatedResults)
  const response: AskAiSearchResponse = {
    answer: verification.answer,
    citations,
    relatedResults: relatedResults.slice(0, 8).map(mapRelatedResult),
    generatedAt: nowIso,
    assistantMode,
    mode: llmAnswer && !verification.downgradedToFallback ? "llm" : "fallback",
    provider: llmAnswer?.provider ?? aiConfig.provider,
    model: llmAnswer?.model ?? aiConfig.model,
    configSource: aiConfig.source,
    confidence: verification.confidence,
    missingData: verification.missingData,
    artifact: artifactData.artifact,
    exports: artifactData.exports,
  }

  await emitTrace(options, {
    id: "verify-grounding-fallback",
    status: verification.downgradedToFallback ? "warning" : "completed",
    label: "Verifying grounded answer",
    detail: verification.downgradedToFallback
      ? "Model answer was replaced with grounded retrieval summary."
      : "Grounding verification passed.",
    thought: verification.notes[0] ?? "Grounding verification completed.",
  })

  await emitTrace(options, {
    id: "done",
    status: "completed",
    label: "Answer ready",
    detail: llmAnswer ? "Generated with model synthesis." : "Generated from retrieval summary.",
  })
  return finalizeResponse(response, {
    plan: {
      planner: "v2_retrieval_fallback",
      entity_types: entityTypes,
    },
    metrics: {
      rows_scanned: relatedResults.length,
      verification_downgraded: verification.downgradedToFallback,
    },
  })
}
