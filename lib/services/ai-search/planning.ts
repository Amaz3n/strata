import "server-only"

import { generateText } from "ai"
import type { AiProvider } from "@/lib/services/ai-config"
import type { EntityAttributeIntent } from "@/lib/services/ai-search/attributes"
import {
  ANALYTICS_ENTITY_CONFIGS,
  ATTRIBUTE_TARGET_NOISE_TOKENS,
  BASE_ENTITY_TYPES,
  COUNT_QUERY_CONFIGS,
  DOCUMENT_ENTITY_TYPES,
  ENTITY_ATTRIBUTE_CONFIGS,
  ENTITY_INTENTS,
  ENTITY_STATUS_VALUES,
  FIELD_ENTITY_TYPES,
  FINANCIAL_ENTITY_TYPES,
  STATUS_ALIASES,
} from "@/lib/services/ai-search/config"
import type { AnalyticsGroupBy, AnalyticsIntent, AnalyticsMetric } from "@/lib/services/ai-search/analytics"
import type { CanonicalMetricIntent, DrawPaymentStatusIntent } from "@/lib/services/ai-search/financial"
import {
  getApiKeyForProvider,
  resolveLanguageModel,
} from "@/lib/services/ai-search/llm"
import { normalizeMemoryFact } from "@/lib/services/ai-search/sessions"
import type { StructuredIntent } from "@/lib/services/ai-search/structured"
import { formatAiToolCatalogForPrompt, getAiToolCatalog } from "@/lib/services/ai-search/tool-catalog"
import type { AiSearchRuntimeFlags } from "@/lib/services/ai-search-flags"
import type { SearchEntityType } from "@/lib/services/search"
import type { AiChartType } from "@/lib/services/ai-search"

const DEFAULT_LIMIT = 20
const MIN_LIMIT = 8
const MAX_LIMIT = 30
const MAX_ANALYTICS_RANGE_DAYS = 730
const REQUEST_TIMEOUT_MS = 12_000
const REQUIRE_LLM_FOR_AI_SEARCH = (() => {
  const raw = process.env.AI_SEARCH_REQUIRE_LLM?.trim().toLowerCase()
  if (!raw) return true
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return true
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false
  return true
})()
export const MEMORY_FACT_LIMIT = 6
const CANONICAL_METRIC_SIGNAL_RE =
  /\b(revenue|sales|income|cash|collected|received|accounts receivable|a\/r|ar|open ar|overdue ar|outstanding|budget|commitment|deposit|draws?|paid|pay)\b/i
const ACTION_ROUTER_SYSTEM_PROMPT = `You route construction workspace requests to guided actions.
Return strict JSON only:
{
  "action": "workflow" | "none",
  "workflowKey": "invoices.create" | null,
  "confidence": number,
  "slots": {
    "projectHint": string,
    "customerHint": string,
    "deliveryMode": "email_now" | "save_draft",
    "lineItems": [{"description": string, "quantity": number, "unitAmountCents": number}]
  }
}

Rules:
- Use workflow "invoices.create" only when the user wants to create, prepare, draft, start, make, write, generate, send, or email a new invoice/bill.
- Do not route questions about whether an existing invoice, deposit, draw, or payment was paid.
- Extract slots only when the user explicitly gives them.
- If the request is just asking a question or searching records, return action "none".
- Confidence must be 0 to 1.`
const QUERY_PLANNER_SYSTEM_PROMPT = `You are a query planner for org data tools.
Return strict JSON only with keys:
- operation: "list" | "count" | "list_and_count" | "analyze" | "aggregate" | "none"
- entityType: one of "project","task","file","contact","company","invoice","payment","budget","estimate","commitment","change_order","contract","proposal","rfi","submittal","drawing_set","drawing_sheet","daily_log","punch_item","schedule_item","photo","portal_access"
- entityTypes: array of entity types when operation is "analyze"
- statuses: string[]
- textQuery: string
- limit: number
- projectName: string
- includeFinancialRollup: boolean
- metric: "count" | "sum_amount" | "avg_amount"
- groupBy: "none" | "status" | "project" | "month"
- dateRangeDays: number

Rules:
- Convert natural language into one safe tool intent.
- Prefer "list" for requests that ask to show/list records.
- Prefer "count" for "how many"/count/total requests.
- Use "list_and_count" if user asks for both count and list.
- Use "analyze" for broad analytical questions (financial health, risk, trends, status summaries).
- Use "aggregate" for grouped/trended analytics (by project/status/month) or totals/averages.
- Use empty textQuery for broad requests like "list all projects".
- statuses must be lowercase snake_case when applicable.
- Infer entityType from semantics even if user doesn't use exact table words.
- Avoid operation "none" unless the question is unrelated to org data.
- If intent cannot be mapped to one entity, return operation "none".
`
const AGENT_QUERY_PLANNER_SYSTEM_PROMPT = `You are a semantic query planner for an org-scoped analytics assistant.
Return strict JSON only with keys:
- operation: "list" | "aggregate" | "none"
- entityType: one of "project","task","file","contact","company","invoice","payment","budget","estimate","commitment","change_order","contract","proposal","rfi","submittal","drawing_set","drawing_sheet","daily_log","punch_item","schedule_item","photo","portal_access"
- relatedEntityTypes: optional array of additional entity types for cross-domain analysis
- metric: "count" | "sum_amount" | "avg_amount"
- groupBy: "none" | "status" | "project" | "month" | "aging"
- statuses: string[]
- textQuery: string
- projectName: string
- dateRangeDays: number
- limit: number
- chartType: "bar" | "horizontalBar" | "line" | "area" | "pie" | "donut" | null

Rules:
- Plan for ONE entityType only.
- Use relatedEntityTypes for secondary entities when the question is cross-domain.
- Use "aggregate" for totals, values, averages, trends, or breakdowns.
- Use "list" for record lookup/open-ended listing requests.
- Keep textQuery empty unless specific keywords materially constrain matching.
- statuses must be lowercase snake_case when applicable.
- Use groupBy "aging" for accounts-receivable aging / how-overdue / by-age questions about invoices (buckets unpaid invoices by days past due). AR aging is invoice-only: use entityType "invoice", metric "sum_amount", chartType "bar", and relatedEntityTypes [].
- chartType: pick the clearest visualization for an aggregate, else null. Use "line" or "area" for time/month trends; "bar" for counts/amounts across categories, statuses, or aging buckets; "horizontalBar" when there are many categories or long labels (e.g. by project, by vendor); "pie" or "donut" for composition/share-of-total (few slices). Use null for "list" operations or single-number answers.
- If question is unrelated to org data, return operation "none".`
const QUERY_DOMAIN_CLASSIFIER_SYSTEM_PROMPT = `Classify the user's question into one domain and return strict JSON only.
Schema:
{
  "domain": "org" | "general" | "social",
  "confidence": "low" | "medium" | "high",
  "reason": string
}

Definitions:
- org: question is about the user's company/workspace data, operations, performance, finances, approvals, projects, or anything that should be answered from internal records.
- general: question is external world knowledge or non-workspace information.
- social: greeting/small talk/chitchat.

Rules:
- Prefer "org" whenever there is plausible business-data intent, even without explicit table/entity names.
- Revenue/profit/cost/performance questions about "we/our/company/business" are "org".
- Keep reason short.
- Output JSON only, no markdown.`
const STRUCTURED_COUNT_HINT_RE = /\b(how many|count|number of|total)\b/
const STRUCTURED_LIST_HINT_RE = /\b(list|show|give me|display|what are|which)\b/
const NON_STRUCTURED_HINT_RE = /\b(summarize|summary|risk|compare|trend|forecast|analysis|analyze|why|how)\b/
const CLARIFICATION_TIME_RANGE_RE = /\b(last|past|this|next)\b/i
const CLARIFICATION_SCOPE_PRONOUN_RE = /\b(that|those|it|them|same|again)\b/i
export const CROSS_DOMAIN_INTENT_RE = /\b(compare|versus|vs\b|across|between|against|correlate|relationship)\b/i
const ORG_CONTEXT_HINT_RE =
  /\b(my|our|project|projects|projet|projets|job|jobs|team|client|vendor|invoice|payment|pay|paid|deposit|draw|draws|budget|estimate|commitment|change order|proposal|contract|rfi|submittal|drawing|task|file|document|contact|company|schedule|daily log|punch)\b/i
const ORG_BUSINESS_METRIC_HINT_RE =
  /\b(revenue|profit|margin|expenses?|spend|costs?|sales|income|run rate|burn|forecast|cash(flow)?|arr|mrr|kpi|performance)\b/i
const ORG_SUBJECT_HINT_RE = /\b(my|our|we|us|company|business|org|organization|workspace|team)\b/i
const GENERAL_KNOWLEDGE_HINT_RE =
  /\b(weather|temperature|recipe|translate|capital of|exchange rate|stock price|crypto price|nba|nfl|mlb|epl|movie|song lyrics|history of|meaning of|define|who is|what is|when is|where is|explain|tell me about)\b/i
const SOCIAL_GREETING_RE = /^(hi|hello|hey|yo|sup|hola|good (morning|afternoon|evening)|what's up)\b/i
const SMALL_TALK_RE = /\b(how are you|who are you|what can you do|thanks|thank you|goodbye|bye)\b/i
const ASSISTANT_META_HINT_RE =
  /\b(model|llm|chat|assistant|system prompt|provider|engine|powering this chat|running locally|lm studio|openai-compatible)\b/i
const ASSISTANT_RUNTIME_INFO_RE =
  /\b(what|which)\b.*\b(model|llm|provider|engine)\b|\b(model|llm|provider|engine)\b.*\b(power|powering|powers|running|using|backing)\b|\bwhat\b.*\b(chat|assistant)\b.*\b(using|running|powered)\b/i
const GENERAL_QUESTION_START_RE = /^(what|which|who|when|where|why|how|explain|define|tell me about)\b/i
const ANALYTICS_INTENT_HINT_RE =
  /\b(by status|status breakdown|by project|per project|over time|trend|monthly|by month|month over month|breakdown|break down|distribution|average|avg|sum of|total amount|total value|aging|ar aging|a\/r aging|by age|days overdue|overdue breakdown|how overdue)\b/
const ANALYTICS_GROUP_BY_STATUS_RE = /\b(by status|status breakdown|status distribution|per status)\b/
const ANALYTICS_GROUP_BY_PROJECT_RE = /\b(by project|per project|project breakdown)\b/
const ANALYTICS_GROUP_BY_MONTH_RE = /\b(over time|trend|monthly|month over month|by month|per month)\b/
const ANALYTICS_GROUP_BY_AGING_RE = /\b(aging|ar aging|a\/r aging|by age|days overdue|overdue breakdown|how overdue|aging report|aging bucket)\b/
const ANALYTICS_METRIC_AVG_RE = /\b(avg|average|mean)\b/
const ANALYTICS_METRIC_SUM_RE = /\b(sum|totals?|total amount|total value|value|worth|dollars|revenue|cost)\b/
const ANALYTICS_VALUE_HINT_RE = /\b(value|worth|amount|total)\b/
const ANALYTICS_QUERY_NOISE_TOKENS = new Set([
  "avg", "average", "break", "breakdown", "by", "count", "distribution", "down", "group", "last", "mean", "month", "monthly", "months", "over", "past", "per", "project", "quarter", "status", "sum", "this", "time", "total", "totals", "trend", "week", "weeks", "year", "years",
])
const INTENT_FILLER_TOKENS = new Set([
  "all", "any", "count", "display", "every", "find", "give", "list", "many", "me", "number", "please", "show", "total",
])
const MAX_QUERY_PLANNER_TOKENS = 220
const STOP_WORDS = new Set([
  "a", "an", "and", "any", "are", "at", "be", "for", "from", "how", "in", "is", "of", "on", "or", "please", "show", "the", "to", "what", "where", "which", "who", "with",
])
const AI_CHART_TYPES: AiChartType[] = ["bar", "horizontalBar", "line", "area", "pie", "donut", "stackedBar"]

type QueryDomain = "org" | "general" | "social"
type QueryDomainConfidence = "low" | "medium" | "high"

type QueryDomainClassification = {
  domain: QueryDomain
  confidence: QueryDomainConfidence
  reason: string
}

type StructuredOperation = "list" | "count" | "list_and_count"

export type AnalysisIntent = {
  kind: "analysis"
  operation: "analyze"
  entityTypes: SearchEntityType[]
  projectName?: string
  statuses: string[]
  textQuery: string
  limit: number
  includeFinancialRollup: boolean
}

type PlannedIntent = StructuredIntent | AnalysisIntent | AnalyticsIntent

type QueryAgentOperation = "list" | "aggregate"

export type QueryAgentPlan = {
  operation: QueryAgentOperation
  entityType: SearchEntityType
  relatedEntityTypes?: SearchEntityType[]
  metric: AnalyticsMetric
  groupBy: AnalyticsGroupBy
  statuses: string[]
  textQuery: string
  projectName?: string
  dateRangeDays?: number
  limit: number
  chartType?: AiChartType
}

export type ActionWorkflowPlan = {
  workflowKey: string
  confidence: number
  slots: Record<string, unknown>
}

const aiPlannerCache = new Map<string, { expiresAt: number; plan: QueryAgentPlan | null }>()

export function pruneAiPlannerCache(now = Date.now()) {
  for (const [key, value] of aiPlannerCache.entries()) {
    if (value.expiresAt <= now) {
      aiPlannerCache.delete(key)
    }
  }
}

function formatEntityType(type: SearchEntityType) {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function extractSessionMemoryFacts(query: string): string[] {
  const facts: string[] = []
  const normalized = query.trim()
  if (!normalized) return facts
  const lower = normalized.toLowerCase()

  const projectName = extractQuotedProjectName(normalized) ?? extractUnquotedProjectName(normalized)
  if (projectName) {
    facts.push(`project_focus=${projectName}`)
  }

  const dateRangeDays = detectDateRangeDays(lower)
  if (dateRangeDays) {
    facts.push(`time_window_days=${dateRangeDays}`)
  }

  const entities = detectEntityMentions(normalized).slice(0, 4)
  if (entities.length > 0) {
    facts.push(`entity_focus=${entities.join(",")}`)
  }

  const statuses = entities.length > 0 ? detectStructuredStatuses(lower, entities[0] ?? "project").slice(0, 3) : []
  if (statuses.length > 0) {
    facts.push(`status_focus=${statuses.join(",")}`)
  }

  const tokens = extractRetrievalQuery(normalized)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 5)
  if (tokens.length > 0) {
    facts.push(`keywords=${tokens.join(",")}`)
  }

  const canonicalMetric = detectCanonicalMetricIntent(normalized, DEFAULT_LIMIT)
  if (canonicalMetric) {
    facts.push(`metric_focus=${canonicalMetric.key}`)
  }

  return Array.from(new Set(facts.map(normalizeMemoryFact).filter((fact) => fact.length > 0))).slice(0, MEMORY_FACT_LIMIT)
}

export function clampLimit(limit?: number) {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(limit)))
}

export function normalizeQuery(query: string) {
  return query.trim().replace(/\s+/g, " ")
}

function cleanJsonCandidate(raw: string) {
  const trimmed = raw.trim()

  if (trimmed.startsWith("```")) {
    return trimmed
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim()
  }

  return trimmed
}

function normalizeSpellingHints(query: string) {
  return query
    .replace(/\bprojets?\b/gi, "projects")
    .replace(/\binovices?\b/gi, "invoices")
    .replace(/\baprovals?\b/gi, "approvals")
    .replace(/\bsubmital(s)?\b/gi, "submittal$1")
}

export function extractRetrievalQuery(query: string) {
  const normalized = normalizeSpellingHints(query)
  const tokens = normalized
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_-]/g, ""))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))

  if (tokens.length === 0) {
    return normalized
  }

  return tokens.slice(0, 7).join(" ")
}

export function pickEntityTypesForQuery(query: string): SearchEntityType[] {
  const lower = normalizeSpellingHints(query).toLowerCase()
  const picked = new Set<SearchEntityType>(BASE_ENTITY_TYPES)

  if (/\b(invoice|payment|bill|budget|forecast|draw|ar|ap|cash|revenue|cost|price|amount)\b/.test(lower)) {
    FINANCIAL_ENTITY_TYPES.forEach((type) => picked.add(type))
  }

  if (/\b(rfi|submittal|drawing|sheet|spec|document|file|contract)\b/.test(lower)) {
    DOCUMENT_ENTITY_TYPES.forEach((type) => picked.add(type))
  }

  if (/\b(contract|agreement|proposal|scope)\b/.test(lower)) {
    picked.add("contract")
    picked.add("proposal")
  }

  if (/\b(task|schedule|milestone|daily\s*log|punch|field|site)\b/.test(lower)) {
    FIELD_ENTITY_TYPES.forEach((type) => picked.add(type))
  }

  return Array.from(picked)
}

function resolveStructuredEntity(query: string) {
  return ENTITY_INTENTS.find((entity) => entity.aliases.some((pattern) => pattern.test(query))) ?? null
}

function normalizeEntityType(value: unknown): SearchEntityType | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_")
  if (!normalized) return null

  const direct = ENTITY_INTENTS.find((entity) => entity.type === normalized)
  if (direct) return direct.type

  const singular = normalized.endsWith("s") ? normalized.slice(0, -1) : normalized
  const singularDirect = ENTITY_INTENTS.find((entity) => entity.type === singular)
  if (singularDirect) return singularDirect.type

  const byToken = ENTITY_INTENTS.find((entity) => entity.tokens.includes(normalized) || entity.tokens.includes(singular))
  return byToken?.type ?? null
}

function normalizePlannerOperation(value: unknown): StructuredOperation | "analyze" | "aggregate" | "none" | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  if (
    normalized === "list" ||
    normalized === "count" ||
    normalized === "list_and_count" ||
    normalized === "analyze" ||
    normalized === "aggregate" ||
    normalized === "none"
  ) {
    return normalized
  }
  return null
}

function detectStructuredStatuses(query: string, entityType: SearchEntityType) {
  const allowed = ENTITY_STATUS_VALUES[entityType]
  if (!allowed || allowed.length === 0) return []

  const allowedSet = new Set(allowed)
  const found: string[] = []
  for (const { pattern, normalized } of STATUS_ALIASES) {
    if (!allowedSet.has(normalized)) continue
    if (!pattern.test(query)) continue
    if (!found.includes(normalized)) found.push(normalized)
  }

  return found
}

function detectAnalyticsMetric(query: string): AnalyticsMetric {
  if (ANALYTICS_METRIC_AVG_RE.test(query)) return "avg_amount"
  if (ANALYTICS_METRIC_SUM_RE.test(query)) return "sum_amount"
  return "count"
}

function detectAnalyticsGroupBy(query: string): AnalyticsGroupBy {
  if (ANALYTICS_GROUP_BY_AGING_RE.test(query)) return "aging"
  if (ANALYTICS_GROUP_BY_STATUS_RE.test(query)) return "status"
  if (ANALYTICS_GROUP_BY_PROJECT_RE.test(query)) return "project"
  if (ANALYTICS_GROUP_BY_MONTH_RE.test(query)) return "month"
  return "none"
}

function detectDateRangeDays(query: string): number | undefined {
  const lower = query.toLowerCase()

  const daysMatch = /\b(?:last|past)\s+(\d{1,3})\s+days?\b/.exec(lower)
  if (daysMatch?.[1]) {
    const parsed = Number.parseInt(daysMatch[1], 10)
    if (Number.isFinite(parsed)) return parsed
  }

  const weeksMatch = /\b(?:last|past)\s+(\d{1,2})\s+weeks?\b/.exec(lower)
  if (weeksMatch?.[1]) {
    const parsed = Number.parseInt(weeksMatch[1], 10)
    if (Number.isFinite(parsed)) return parsed * 7
  }

  const monthsMatch = /\b(?:last|past)\s+(\d{1,2})\s+months?\b/.exec(lower)
  if (monthsMatch?.[1]) {
    const parsed = Number.parseInt(monthsMatch[1], 10)
    if (Number.isFinite(parsed)) return parsed * 30
  }

  if (/\b(last quarter|past quarter|this quarter)\b/.test(lower)) return 90
  if (/\b(last year|past year|this year|ytd)\b/.test(lower)) return 365
  return undefined
}

function clampDateRangeDays(value?: number) {
  if (!value || Number.isNaN(value)) return undefined
  return Math.max(7, Math.min(MAX_ANALYTICS_RANGE_DAYS, Math.floor(value)))
}

function extractRequestedLimit(query: string, fallback: number) {
  const explicit =
    /\b(?:top|first|last)\s+(\d{1,3})\b/i.exec(query) ??
    /\b(\d{1,3})\s+(?:projects?|tasks?|files?|invoices?|rfis?|submittals?|contacts?|companies?)\b/i.exec(query)

  if (!explicit) return fallback
  const parsed = Number.parseInt(explicit[1] ?? "", 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(MAX_LIMIT, parsed))
}

function stripIntentTokens(query: string, entityTokens: string[], statuses: string[]) {
  const statusTokens = statuses.flatMap((status) => status.split("_"))
  const removable = new Set<string>([...entityTokens, ...statusTokens, ...INTENT_FILLER_TOKENS])
  return extractRetrievalQuery(query)
    .split(/\s+/)
    .filter((token) => {
      if (token.length === 0) return false
      if (removable.has(token)) return false
      const singular = token.endsWith("s") ? token.slice(0, -1) : token
      return !removable.has(singular)
    })
    .join(" ")
}

function normalizeAnalyticsTextQuery(value: string) {
  const cleaned = value
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_-]/g, ""))
    .filter((token) => token.length > 0)
    .filter((token) => {
      if (ANALYTICS_QUERY_NOISE_TOKENS.has(token)) return false
      const singular = token.endsWith("s") ? token.slice(0, -1) : token
      return !ANALYTICS_QUERY_NOISE_TOKENS.has(singular)
    })

  return cleaned.join(" ")
}

function parseStructuredIntent(query: string, fallbackLimit: number): StructuredIntent | null {
  const lower = query.toLowerCase()
  const isCount = STRUCTURED_COUNT_HINT_RE.test(lower)
  const isList = STRUCTURED_LIST_HINT_RE.test(lower)
  const entity = resolveStructuredEntity(lower)
  if (!entity) return null

  const hasDirectStatusIntent = /\b(active|planning|bidding|on hold|completed|cancelled|in progress|todo|blocked|done|open|pending|approved|rejected|resolved|overdue)\b/.test(
    lower,
  )
  if (!isCount && !isList && !hasDirectStatusIntent) return null

  // Keep richer analytical prompts on the normal retrieval+synthesis path.
  if (NON_STRUCTURED_HINT_RE.test(lower) && !isCount) {
    return null
  }

  const statuses = detectStructuredStatuses(lower, entity.type)
  const textQuery = stripIntentTokens(query, entity.tokens, statuses)

  return {
    kind: "structured",
    operation: isCount ? "count" : "list",
    entityType: entity.type,
    entityLabel: entity.label,
    entityTokens: entity.tokens,
    statuses,
    textQuery,
    limit: extractRequestedLimit(query, fallbackLimit),
  }
}

function sanitizeAttributeTargetHint(value: string) {
  const candidate = value
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/[?.,!;:]+$/g, "")
    .replace(/\s+/g, " ")
  if (candidate.length < 2) return undefined

  const normalizedTokens = candidate
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !ATTRIBUTE_TARGET_NOISE_TOKENS.has(token))
  if (normalizedTokens.length === 0) return undefined
  return candidate
}

function extractAttributeTargetHint(query: string, entityType: SearchEntityType) {
  const quoted = extractQuotedProjectName(query)
  if (quoted) return quoted

  if (entityType === "project") {
    const projectHint = extractUnquotedProjectName(query)
    if (projectHint) return projectHint
  }

  const compact = query.trim().replace(/\s+/g, " ")
  const patterns = [
    /\b(?:for|of|on|in)\s+(?:the\s+)?(?:project|job|company|vendor|contact|person)?\s*["“]?([^"”]+?)["”]?\s*$/i,
    /\b(?:project|job|company|vendor|contact|person)\s+(?:named|called)?\s*["“]?([^"”]+?)["”]?\s*$/i,
    /\b(?:address|location|jobsite|site address|status|start date|end date|completion date|total value|project value|contract value|description|scope|summary|email|e-mail|phone|telephone|mobile|website|url|role|title|position)\s+(?:for|of)\s+(?:the\s+)?(?:project|job|company|vendor|contact|person)?\s*["“]?([^"”]+?)["”]?\s*$/i,
    /\b(?:project|job|company|vendor|contact|person)\s+(?:named|called)?\s*["“]?([^"”]+?)["”]?\s+(?:address|location|jobsite|site address|status|start date|end date|completion date|total value|project value|contract value|description|scope|summary|email|e-mail|phone|telephone|mobile|website|url|role|title|position)\b/i,
    /\b["“]?([^"”]+?)["”]?\s+(?:project|job|company|vendor|contact|person)\s+(?:address|location|jobsite|site address|status|start date|end date|completion date|total value|project value|contract value|description|scope|summary|email|e-mail|phone|telephone|mobile|website|url|role|title|position)\b/i,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(compact)
    if (!match?.[1]) continue
    const sanitized = sanitizeAttributeTargetHint(match[1])
    if (sanitized) return sanitized
  }

  return undefined
}

export function detectEntityAttributeIntent(query: string): EntityAttributeIntent | null {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return null
  if (STRUCTURED_COUNT_HINT_RE.test(normalized)) return null

  const hasAddressLikeIntent = /\b(address|location|jobsite|site address)\b/.test(normalized)
  const hasContactLikeIntent = /\b(email|e-mail|phone|telephone|mobile|website|url|role|title|position)\b/.test(normalized)
  const hasProjectDetailIntent = /\b(start date|end date|completion|contract value|total value|description|scope|status)\b/.test(normalized)
  const hasAttributeKeyword = hasAddressLikeIntent || hasContactLikeIntent || hasProjectDetailIntent
  const asksAttribute = /\b(what(?:'s| is)?|show|give|tell|where|which|who)\b/.test(normalized)
  const implicitFieldLookup = hasAttributeKeyword && /\b(for|of)\b/.test(normalized)
  if (!asksAttribute && !implicitFieldLookup) return null

  const mentioned = detectEntityMentions(query).filter(
    (entityType): entityType is SearchEntityType => Boolean(ENTITY_ATTRIBUTE_CONFIGS[entityType]),
  )
  let candidateEntities = mentioned

  if (candidateEntities.length === 0) {
    if (hasAddressLikeIntent || hasProjectDetailIntent) {
      candidateEntities = ["project", "company", "contact"]
    } else if (hasContactLikeIntent) {
      candidateEntities = ["contact", "company"]
    } else {
      return null
    }
  }

  for (const entityType of candidateEntities) {
    const config = ENTITY_ATTRIBUTE_CONFIGS[entityType]
    if (!config) continue

    let field = config.fields.find((candidateField) => candidateField.aliases.some((pattern) => pattern.test(normalized)))
    if (!field && /^\s*where\b/.test(normalized) && config.defaultFieldKey) {
      field = config.fields.find((candidateField) => candidateField.key === config.defaultFieldKey)
    }
    if (!field) continue

    const targetHint = extractAttributeTargetHint(query, entityType)
    if (!asksAttribute && !targetHint) {
      continue
    }

    return {
      entityType,
      fieldKey: field.key,
      targetHint,
    }
  }

  return null
}

export function normalizeAnalyticsMetric(metric: AnalyticsMetric, entityType: SearchEntityType): AnalyticsMetric {
  const config = ANALYTICS_ENTITY_CONFIGS[entityType]
  if (!config?.amountField && (metric === "sum_amount" || metric === "avg_amount")) {
    return "count"
  }
  return metric
}

export function normalizeAnalyticsGroupBy(groupBy: AnalyticsGroupBy, entityType: SearchEntityType): AnalyticsGroupBy {
  const config = ANALYTICS_ENTITY_CONFIGS[entityType]
  if (!config) return "none"
  if (groupBy === "status" && !config.statusField) return "none"
  if (groupBy === "project" && !config.projectIdField) return "none"
  if (groupBy === "month" && !config.createdAtField) return "none"
  // Aging only applies to entities with a due date (currently invoices).
  if (groupBy === "aging" && !config.dueDateField) return "none"
  return groupBy
}

function parseAnalyticsIntent(query: string, fallbackLimit: number): AnalyticsIntent | null {
  const lower = query.toLowerCase()
  const entity = resolveStructuredEntity(lower)
  const isValueAnalytics = Boolean(entity) && ANALYTICS_VALUE_HINT_RE.test(lower)
  if (!ANALYTICS_INTENT_HINT_RE.test(lower) && !isValueAnalytics) return null
  if (!entity || !ANALYTICS_ENTITY_CONFIGS[entity.type]) return null

  const statuses = detectStructuredStatuses(lower, entity.type)
  const textQuery = normalizeAnalyticsTextQuery(stripIntentTokens(query, entity.tokens, statuses))
  const metric = normalizeAnalyticsMetric(detectAnalyticsMetric(lower), entity.type)
  const groupBy = normalizeAnalyticsGroupBy(detectAnalyticsGroupBy(lower), entity.type)
  const dateRangeDays = clampDateRangeDays(detectDateRangeDays(lower))
  const projectName = extractQuotedProjectName(query) ?? extractUnquotedProjectName(query)

  return {
    kind: "analytics",
    operation: "aggregate",
    entityType: entity.type,
    metric,
    groupBy,
    statuses,
    textQuery,
    projectName,
    dateRangeDays,
    limit: extractRequestedLimit(query, fallbackLimit),
  }
}

export function detectCanonicalMetricIntent(query: string, fallbackLimit: number): CanonicalMetricIntent | null {
  const normalized = query.trim()
  if (!normalized) return null
  const lower = normalized.toLowerCase()
  if (!CANONICAL_METRIC_SIGNAL_RE.test(lower)) return null

  const projectName = extractQuotedProjectName(normalized) ?? extractUnquotedProjectName(normalized)
  const dateRangeDays = clampDateRangeDays(detectDateRangeDays(lower))
  const groupBy = normalizeAnalyticsGroupBy(detectAnalyticsGroupBy(lower), "invoice")
  const limit = Math.max(8, Math.min(20, extractRequestedLimit(normalized, fallbackLimit)))

  if (/\b(commitments?\s+(?:exceed|over|vs|versus|against)\s+budgets?|budget(?:s)?\s+(?:vs|versus|against)\s+commitments?)\b/.test(lower)) {
    return {
      key: "budget_commitment_gap",
      label: "Budget vs commitments gap",
      projectName,
      dateRangeDays,
      groupBy: "none",
      limit,
    }
  }

  if (/\b(overdue\s+(?:ar|a\/r|accounts?\s+receivable)|past[-\s]?due\s+(?:ar|a\/r|accounts?\s+receivable))\b/.test(lower)) {
    return {
      key: "overdue_ar",
      label: "Overdue AR",
      projectName,
      dateRangeDays,
      groupBy,
      limit,
    }
  }

  if (
    /\b(open\s+(?:ar|a\/r|accounts?\s+receivable)|outstanding\s+(?:ar|a\/r|receivables?)|unpaid\s+invoices?)\b/.test(
      lower,
    )
  ) {
    return {
      key: "open_ar",
      label: "Open AR",
      projectName,
      dateRangeDays,
      groupBy,
      limit,
    }
  }

  if (/\b(cash\s+(?:in|inflow)|payments?\s+received|collected|cash\s+collected)\b/.test(lower)) {
    return {
      key: "cash_collected",
      label: "Cash collected",
      projectName,
      dateRangeDays,
      groupBy: normalizeAnalyticsGroupBy(groupBy, "payment"),
      limit,
    }
  }

  if (/\b(revenue|sales|income|topline)\b/.test(lower)) {
    return {
      key: "revenue_billed",
      label: "Revenue billed",
      projectName,
      dateRangeDays,
      groupBy,
      limit,
    }
  }

  return null
}

export function detectDrawPaymentStatusIntent(
  query: string,
  fallbackLimit: number,
  currentProjectId?: string | null,
): DrawPaymentStatusIntent | null {
  const normalized = query.trim()
  if (!normalized) return null
  const lower = normalized.toLowerCase()
  const mentionsDrawOrDeposit = /\b(deposit|draws?|draw\s*#?\s*\d+)\b/i.test(normalized)
  const asksPaymentStatus = /\b(pay|paid|payment|received|collected|settled|balance|outstanding|open|unpaid|status|complete|closed)\b/i.test(normalized)
  if (!mentionsDrawOrDeposit || !asksPaymentStatus) return null

  const drawNumbers = new Set<number>()
  const includeDeposit = /\bdeposit\b/i.test(normalized)
  if (includeDeposit) drawNumbers.add(0)

  const drawPhraseMatches = normalized.matchAll(/\bdraws?\s*(?:#|number|no\.?)?\s*((?:\d+\s*(?:,|and|&)?\s*)+)/gi)
  for (const match of drawPhraseMatches) {
    const rawNumbers = match[1] ?? ""
    for (const numberMatch of rawNumbers.matchAll(/\d+/g)) {
      const drawNumber = Number.parseInt(numberMatch[0], 10)
      if (Number.isFinite(drawNumber) && drawNumber >= 0 && drawNumber <= 100) {
        drawNumbers.add(drawNumber)
      }
    }
  }

  return {
    projectName: extractQuotedProjectName(normalized) ?? extractUnquotedProjectName(normalized),
    projectId: currentProjectId ?? undefined,
    drawNumbers: Array.from(drawNumbers).sort((a, b) => a - b),
    includeDeposit,
    limit: Math.max(8, Math.min(20, extractRequestedLimit(normalized, fallbackLimit))),
  }
}

export function normalizePlannerStatuses(rawStatuses: unknown, entityType: SearchEntityType) {
  const allowed = new Set(ENTITY_STATUS_VALUES[entityType] ?? [])
  if (allowed.size === 0) return []

  if (!Array.isArray(rawStatuses)) return []
  const normalized: string[] = []
  for (const status of rawStatuses) {
    if (typeof status !== "string") continue
    const candidate = status.trim().toLowerCase().replace(/\s+/g, "_")
    if (!candidate || !allowed.has(candidate)) continue
    if (!normalized.includes(candidate)) normalized.push(candidate)
  }
  return normalized
}

function normalizePlannerEntityTypes(raw: unknown, fallbackQuery: string) {
  const resolved: SearchEntityType[] = []

  if (Array.isArray(raw)) {
    for (const value of raw) {
      const normalized = normalizeEntityType(value)
      if (!normalized) continue
      if (!resolved.includes(normalized)) resolved.push(normalized)
    }
  } else {
    const single = normalizeEntityType(raw)
    if (single) {
      resolved.push(single)
    }
  }

  if (resolved.length > 0) return resolved
  return pickEntityTypesForQuery(fallbackQuery)
}

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function extractQuotedProjectName(query: string) {
  const quoted = query.match(/["']([^"']{3,})["']/)
  if (!quoted) return undefined
  const candidate = quoted[1]?.trim()
  return candidate && candidate.length >= 3 ? candidate : undefined
}

function extractUnquotedProjectName(query: string) {
  const patterns = [
    /\bfor\s+(?:the\s+)?(.+?)\s+project\b/i,
    /\bof\s+(?:the\s+)?(.+?)\s+project\b/i,
    /\bin\s+(?:the\s+)?(.+?)\s+project\b/i,
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(query)
    if (!match?.[1]) continue
    const candidate = match[1]
      .trim()
      .replace(/[?.,!;:]+$/g, "")
      .replace(/\s+/g, " ")

    if (candidate.length >= 3) return candidate
  }

  return undefined
}

function normalizePlannerAnalyticsMetric(
  rawMetric: unknown,
  entityType: SearchEntityType,
  fallbackQuery: string,
): AnalyticsMetric {
  const fromQuery = detectAnalyticsMetric(fallbackQuery.toLowerCase())
  if (typeof rawMetric !== "string") {
    return normalizeAnalyticsMetric(fromQuery, entityType)
  }

  const normalized = rawMetric.trim().toLowerCase()
  if (normalized === "count" || normalized === "sum_amount" || normalized === "avg_amount") {
    return normalizeAnalyticsMetric(normalized, entityType)
  }

  return normalizeAnalyticsMetric(fromQuery, entityType)
}

function normalizePlannerAnalyticsGroupBy(
  rawGroupBy: unknown,
  entityType: SearchEntityType,
  fallbackQuery: string,
): AnalyticsGroupBy {
  const fromQuery = detectAnalyticsGroupBy(fallbackQuery.toLowerCase())
  if (typeof rawGroupBy !== "string") {
    return normalizeAnalyticsGroupBy(fromQuery, entityType)
  }

  const normalized = rawGroupBy.trim().toLowerCase()
  if (
    normalized === "none" ||
    normalized === "status" ||
    normalized === "project" ||
    normalized === "month" ||
    normalized === "aging"
  ) {
    return normalizeAnalyticsGroupBy(normalized, entityType)
  }

  return normalizeAnalyticsGroupBy(fromQuery, entityType)
}

function normalizePlannerDateRangeDays(rawDateRangeDays: unknown, fallbackQuery: string) {
  if (typeof rawDateRangeDays === "number" && Number.isFinite(rawDateRangeDays)) {
    return clampDateRangeDays(rawDateRangeDays)
  }

  return clampDateRangeDays(detectDateRangeDays(fallbackQuery.toLowerCase()))
}

function buildPlannerSchemaContext() {
  const lines: string[] = []
  const toolCatalog = getAiToolCatalog()
  const entitySet = new Set<SearchEntityType>([
    ...ENTITY_INTENTS.map((entity) => entity.type),
    ...(Object.keys(COUNT_QUERY_CONFIGS) as SearchEntityType[]),
    ...(Object.keys(ANALYTICS_ENTITY_CONFIGS) as SearchEntityType[]),
  ])

  for (const entityType of entitySet) {
    const entity = ENTITY_INTENTS.find((item) => item.type === entityType)
    const countConfig = COUNT_QUERY_CONFIGS[entityType]
    const analyticsConfig = ANALYTICS_ENTITY_CONFIGS[entityType]
    const statusValues = ENTITY_STATUS_VALUES[entityType] ?? []
    const aliasHint =
      entity?.tokens.slice(0, 4).join(", ") ??
      entityType.split("_").join(",") ??
      entityType
    const toolKeys = toolCatalog
      .filter((tool) => tool.entities.includes(entityType))
      .map((tool) => tool.key)
      .slice(0, 4)
      .join(",")
    const tableName = analyticsConfig?.table ?? countConfig?.table
    const supports = [
      countConfig ? "list/count" : null,
      analyticsConfig ? "aggregate" : null,
      statusValues.length > 0 ? "status filters" : null,
      analyticsConfig?.amountField ? "amount metrics" : null,
      analyticsConfig?.projectIdField ? "project grouping" : null,
      analyticsConfig?.createdAtField ? "time grouping" : null,
    ]
      .filter((item): item is string => Boolean(item))
      .join(", ")
    const searchFields = [
      ...(countConfig?.searchableFields ?? []),
      ...(analyticsConfig?.searchableFields ?? []),
    ]
    const uniqueSearchFields = Array.from(new Set(searchFields)).slice(0, 5)

    lines.push(
      `- ${entityType}: table=${tableName ?? "n/a"}; aliases=${aliasHint || entityType}; supports=${supports || "n/a"}${
        statusValues.length > 0 ? `; statuses=${statusValues.join(",")}` : ""
      }${uniqueSearchFields.length > 0 ? `; fields=${uniqueSearchFields.join(",")}` : ""}${
        toolKeys ? `; tools=${toolKeys}` : ""
      }`,
    )
  }

  lines.push(
    "- canonical_metrics: revenue_billed, cash_collected, open_ar, overdue_ar, budget_commitment_gap (org-scoped, optionally project/time filtered)",
  )
  return lines.join("\n")
}

function parsePlannerIntent(raw: string, fallbackLimit: number, query: string): PlannedIntent | null {
  const candidate = cleanJsonCandidate(raw)
  const segments = [candidate]
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    segments.push(raw.slice(start, end + 1).trim())
  }

  for (const segment of segments) {
    try {
      const parsed = JSON.parse(segment) as {
        operation?: unknown
        entityType?: unknown
        entityTypes?: unknown
        statuses?: unknown
        textQuery?: unknown
        limit?: unknown
        projectName?: unknown
        includeFinancialRollup?: unknown
        metric?: unknown
        groupBy?: unknown
        dateRangeDays?: unknown
      }

      const operation = normalizePlannerOperation(parsed.operation)
      if (!operation) continue
      if (operation === "none") return null

      const rawTextQuery = typeof parsed.textQuery === "string" ? parsed.textQuery.trim() : ""
      const limitValue =
        typeof parsed.limit === "number" && Number.isFinite(parsed.limit)
          ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed.limit)))
          : fallbackLimit
      const projectName =
        normalizeOptionalString(parsed.projectName) ??
        extractQuotedProjectName(query) ??
        extractUnquotedProjectName(query)

      if (operation === "analyze") {
        const entityTypes = normalizePlannerEntityTypes(parsed.entityTypes ?? parsed.entityType, query)
        const primaryEntity = entityTypes[0]
        const statuses = primaryEntity ? normalizePlannerStatuses(parsed.statuses, primaryEntity) : []
        const includeFinancialRollup =
          parsed.includeFinancialRollup === true ||
          /\b(financial|finance|cost|revenue|budget|invoice|payment|cash|margin|profit)\b/i.test(query)

        return {
          kind: "analysis",
          operation: "analyze",
          entityTypes,
          projectName,
          statuses,
          textQuery: rawTextQuery,
          limit: limitValue,
          includeFinancialRollup,
        }
      }

      if (operation === "aggregate") {
        const entityType = normalizeEntityType(parsed.entityType)
        if (!entityType || !ANALYTICS_ENTITY_CONFIGS[entityType]) continue

        const statuses = normalizePlannerStatuses(parsed.statuses, entityType)
        const metric = normalizePlannerAnalyticsMetric(parsed.metric, entityType, query)
        const groupBy = normalizePlannerAnalyticsGroupBy(parsed.groupBy, entityType, query)
        const dateRangeDays = normalizePlannerDateRangeDays(parsed.dateRangeDays, query)
        const entityTokens = ENTITY_INTENTS.find((entity) => entity.type === entityType)?.tokens ?? [entityType]
        const querySeed = rawTextQuery || stripIntentTokens(query, entityTokens, statuses)
        const textQuery = normalizeAnalyticsTextQuery(querySeed)

        return {
          kind: "analytics",
          operation: "aggregate",
          entityType,
          metric,
          groupBy,
          statuses,
          textQuery,
          projectName,
          dateRangeDays,
          limit: limitValue,
        }
      }

      const entityType = normalizeEntityType(parsed.entityType)
      if (!entityType) continue
      const statuses = normalizePlannerStatuses(parsed.statuses, entityType)

      const label = ENTITY_INTENTS.find((entity) => entity.type === entityType)?.label ?? formatEntityType(entityType).toLowerCase()
      const tokens = ENTITY_INTENTS.find((entity) => entity.type === entityType)?.tokens ?? [entityType]

      return {
        kind: "structured",
        operation,
        entityType,
        entityLabel: label,
        entityTokens: tokens,
        statuses,
        textQuery: rawTextQuery,
        limit: limitValue,
      }
    } catch {
      continue
    }
  }

  return null
}

async function planQueryIntentWithLlm(
  query: string,
  provider: AiProvider,
  model: string,
  fallbackLimit: number,
) {
  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey) return null

  const languageModel = resolveLanguageModel(provider, apiKey, model)
  try {
    const schemaContext = buildPlannerSchemaContext()
    const toolCatalog = formatAiToolCatalogForPrompt()
    const result = await generateText({
      model: languageModel,
      system: QUERY_PLANNER_SYSTEM_PROMPT,
      prompt: `Question:\n${query}\n\nAvailable semantic datasets:\n${schemaContext}\n\nAvailable tools:\n${toolCatalog}`,
      temperature: 0,
      maxOutputTokens: Math.max(MAX_QUERY_PLANNER_TOKENS, 320),
      timeout: REQUEST_TIMEOUT_MS,
    })

    return parsePlannerIntent(result.text, fallbackLimit, query)
  } catch (error) {
    console.error("AI query planning failed", error)
    return null
  }
}

function normalizeWorkflowSlots(value: unknown, currentProjectId?: string | null): Record<string, unknown> {
  const slots: Record<string, unknown> = {}
  if (value && typeof value === "object") {
    const raw = value as Record<string, unknown>
    for (const key of ["projectHint", "customerHint"]) {
      if (typeof raw[key] === "string" && raw[key].trim()) {
        slots[key] = raw[key].trim()
      }
    }
    if (raw.deliveryMode === "email_now" || raw.deliveryMode === "save_draft") {
      slots.deliveryMode = raw.deliveryMode
    }
    if (Array.isArray(raw.lineItems)) {
      const lineItems = raw.lineItems
        .map((item) => {
          if (!item || typeof item !== "object") return null
          const record = item as Record<string, unknown>
          const description = typeof record.description === "string" ? record.description.trim() : ""
          const quantity = typeof record.quantity === "number" && Number.isFinite(record.quantity) ? record.quantity : 1
          const unitAmountCents =
            typeof record.unitAmountCents === "number" && Number.isFinite(record.unitAmountCents)
              ? Math.round(record.unitAmountCents)
              : null
          if (!description || unitAmountCents === null || unitAmountCents <= 0) return null
          return { description, quantity: Math.max(1, quantity), unitAmountCents }
        })
        .filter((item): item is { description: string; quantity: number; unitAmountCents: number } => Boolean(item))
      if (lineItems.length > 0) {
        slots.lineItems = lineItems.slice(0, 12)
      }
    }
  }
  if (currentProjectId) {
    slots.pageProjectId = currentProjectId
  }
  return slots
}

function parseActionWorkflowPlan(
  raw: string,
  currentProjectId?: string | null,
): ActionWorkflowPlan | null {
  const candidates = [cleanJsonCandidate(raw)]
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    candidates.push(raw.slice(start, end + 1).trim())
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        action?: unknown
        workflowKey?: unknown
        confidence?: unknown
        slots?: unknown
      }
      if (parsed.action !== "workflow" || parsed.workflowKey !== "invoices.create") continue
      const confidence =
        typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0
      if (confidence <= 0) continue
      return {
        workflowKey: "invoices.create",
        confidence,
        slots: normalizeWorkflowSlots(parsed.slots, currentProjectId),
      }
    } catch {
      continue
    }
  }

  return null
}

export async function planActionWorkflowWithLlm({
  query,
  provider,
  model,
  currentProjectId,
}: {
  query: string
  provider: AiProvider
  model: string
  currentProjectId?: string | null
}): Promise<ActionWorkflowPlan | null> {
  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey) return null

  const languageModel = resolveLanguageModel(provider, apiKey, model)
  try {
    const result = await generateText({
      model: languageModel,
      system: ACTION_ROUTER_SYSTEM_PROMPT,
      prompt: `User request:\n${query}`,
      temperature: 0,
      maxOutputTokens: 320,
      timeout: REQUEST_TIMEOUT_MS,
    })
    return parseActionWorkflowPlan(result.text, currentProjectId)
  } catch (error) {
    console.error("AI action workflow routing failed", error)
    return null
  }
}

export function normalizeQueryAgentOperation(value: unknown): QueryAgentOperation | "none" | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  if (normalized === "list" || normalized === "aggregate" || normalized === "none") {
    return normalized
  }
  return null
}

function deriveRelatedEntitiesFromQuery(query: string, primaryEntity: SearchEntityType): SearchEntityType[] {
  const mentions = detectEntityMentions(query)
  const related = mentions.filter((entityType) => entityType !== primaryEntity)
  return Array.from(new Set(related)).slice(0, 3)
}

function buildHeuristicQueryAgentPlan(query: string, fallbackLimit: number): QueryAgentPlan | null {
  const analytics = parseAnalyticsIntent(query, fallbackLimit)
  if (analytics) {
    return {
      operation: "aggregate",
      entityType: analytics.entityType,
      relatedEntityTypes: deriveRelatedEntitiesFromQuery(query, analytics.entityType),
      metric: analytics.metric,
      groupBy: analytics.groupBy,
      statuses: analytics.statuses,
      textQuery: analytics.textQuery,
      projectName: analytics.projectName,
      dateRangeDays: analytics.dateRangeDays,
      limit: analytics.limit,
    }
  }

  const structured = parseStructuredIntent(query, fallbackLimit)
  if (structured) {
    if (structured.operation === "count" || structured.operation === "list_and_count") {
      return {
        operation: "aggregate",
        entityType: structured.entityType,
        relatedEntityTypes: deriveRelatedEntitiesFromQuery(query, structured.entityType),
        metric: "count",
        groupBy: "none",
        statuses: structured.statuses,
        textQuery: structured.textQuery,
        projectName: extractQuotedProjectName(query) ?? extractUnquotedProjectName(query),
        dateRangeDays: clampDateRangeDays(detectDateRangeDays(query.toLowerCase())),
        limit: structured.limit,
      }
    }

    return {
      operation: "list",
      entityType: structured.entityType,
      relatedEntityTypes: deriveRelatedEntitiesFromQuery(query, structured.entityType),
      metric: "count",
      groupBy: "none",
      statuses: structured.statuses,
      textQuery: structured.textQuery,
      projectName: extractQuotedProjectName(query) ?? extractUnquotedProjectName(query),
      dateRangeDays: clampDateRangeDays(detectDateRangeDays(query.toLowerCase())),
      limit: structured.limit,
    }
  }

  const lower = query.toLowerCase()
  const entity = resolveStructuredEntity(lower)
  if (!entity) return null

  const statuses = detectStructuredStatuses(lower, entity.type)
  const textQuery = stripIntentTokens(query, entity.tokens, statuses)
  const projectName = extractQuotedProjectName(query) ?? extractUnquotedProjectName(query)
  const dateRangeDays = clampDateRangeDays(detectDateRangeDays(lower))
  const isAggregate = ANALYTICS_INTENT_HINT_RE.test(lower) || ANALYTICS_VALUE_HINT_RE.test(lower) || STRUCTURED_COUNT_HINT_RE.test(lower)

  if (isAggregate && ANALYTICS_ENTITY_CONFIGS[entity.type]) {
    return {
      operation: "aggregate",
      entityType: entity.type,
      relatedEntityTypes: deriveRelatedEntitiesFromQuery(query, entity.type),
      metric: normalizeAnalyticsMetric(detectAnalyticsMetric(lower), entity.type),
      groupBy: normalizeAnalyticsGroupBy(detectAnalyticsGroupBy(lower), entity.type),
      statuses,
      textQuery: normalizeAnalyticsTextQuery(textQuery),
      projectName,
      dateRangeDays,
      limit: extractRequestedLimit(query, fallbackLimit),
    }
  }

  return {
    operation: "list",
    entityType: entity.type,
    relatedEntityTypes: deriveRelatedEntitiesFromQuery(query, entity.type),
    metric: "count",
    groupBy: "none",
    statuses,
    textQuery,
    projectName,
    dateRangeDays,
    limit: extractRequestedLimit(query, fallbackLimit),
  }
}

// Resolves the planner's chartType hint, falling back to a sensible default
// derived from the grouping when the model omits or fumbles it.
function normalizePlannerChartType(raw: unknown, groupBy: AnalyticsGroupBy): AiChartType | undefined {
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase()
    const match = AI_CHART_TYPES.find((type) => type.toLowerCase() === value)
    if (match) return match
    if (value === "horizontal" || value === "hbar" || value === "horizontal_bar") return "horizontalBar"
    if (value === "stacked" || value === "stacked_bar") return "stackedBar"
    if (value === "doughnut") return "donut"
  }
  if (groupBy === "month") return "line"
  if (groupBy === "status" || groupBy === "project" || groupBy === "aging") return "bar"
  return undefined
}

function parseQueryAgentPlan(raw: string, query: string, fallbackLimit: number): QueryAgentPlan | null {
  const candidate = cleanJsonCandidate(raw)
  const segments = [candidate]
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    segments.push(raw.slice(start, end + 1).trim())
  }

  for (const segment of segments) {
    try {
      const parsed = JSON.parse(segment) as {
        operation?: unknown
        entityType?: unknown
        relatedEntityTypes?: unknown
        metric?: unknown
        groupBy?: unknown
        statuses?: unknown
        textQuery?: unknown
        projectName?: unknown
        dateRangeDays?: unknown
        limit?: unknown
        chartType?: unknown
      }

      const operation = normalizeQueryAgentOperation(parsed.operation)
      if (!operation) continue
      if (operation === "none") return null

      const entityType =
        normalizeEntityType(parsed.entityType) ??
        resolveStructuredEntity(query.toLowerCase())?.type ??
        normalizeEntityType(extractRetrievalQuery(query).split(" ")[0] ?? "")
      if (!entityType) continue
      const relatedEntityTypes = normalizePlannerEntityTypes(parsed.relatedEntityTypes, query).filter(
        (candidate) => candidate !== entityType,
      )

      const statuses = normalizePlannerStatuses(parsed.statuses, entityType)
      const limit =
        typeof parsed.limit === "number" && Number.isFinite(parsed.limit)
          ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(parsed.limit)))
          : extractRequestedLimit(query, fallbackLimit)

      const projectName =
        normalizeOptionalString(parsed.projectName) ??
        extractQuotedProjectName(query) ??
        extractUnquotedProjectName(query)
      const dateRangeDays = normalizePlannerDateRangeDays(parsed.dateRangeDays, query)
      const lowerQuery = query.toLowerCase()
      const shouldForceAggregate =
        operation === "list" &&
        ANALYTICS_VALUE_HINT_RE.test(lowerQuery) &&
        Boolean(ANALYTICS_ENTITY_CONFIGS[entityType]?.amountField)

      if (operation === "aggregate" || shouldForceAggregate) {
        const groupBy = normalizePlannerAnalyticsGroupBy(parsed.groupBy, entityType, query)
        const metric =
          groupBy === "aging"
            ? "sum_amount"
            : normalizePlannerAnalyticsMetric(parsed.metric, entityType, query)
        const entityTokens = ENTITY_INTENTS.find((entity) => entity.type === entityType)?.tokens ?? [entityType]
        const rawText = typeof parsed.textQuery === "string" ? parsed.textQuery.trim() : ""
        const querySeed = rawText || stripIntentTokens(query, entityTokens, statuses)
        return {
          operation: "aggregate",
          entityType,
          relatedEntityTypes: groupBy === "aging" ? [] : relatedEntityTypes,
          metric,
          groupBy,
          statuses,
          textQuery: normalizeAnalyticsTextQuery(querySeed),
          projectName,
          dateRangeDays,
          limit,
          chartType: normalizePlannerChartType(parsed.chartType, groupBy),
        }
      }

      const entityTokens = ENTITY_INTENTS.find((entity) => entity.type === entityType)?.tokens ?? [entityType]
      const rawText = typeof parsed.textQuery === "string" ? parsed.textQuery.trim() : ""
      return {
        operation: "list",
        entityType,
        relatedEntityTypes,
        metric: "count",
        groupBy: "none",
        statuses,
        textQuery: rawText || stripIntentTokens(query, entityTokens, statuses),
        projectName,
        dateRangeDays,
        limit,
      }
    } catch {
      continue
    }
  }

  return null
}

export async function planQueryWithAgent(
  query: string,
  provider: AiProvider,
  model: string,
  fallbackLimit: number,
) {
  const heuristicPlan = buildHeuristicQueryAgentPlan(query, fallbackLimit)
  const plannerCacheKey = `${provider}:${model}:${fallbackLimit}:${query.trim().toLowerCase()}`
  const cached = aiPlannerCache.get(plannerCacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.plan ?? (REQUIRE_LLM_FOR_AI_SEARCH ? null : heuristicPlan)
  }

  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey) {
    const fallbackPlan = REQUIRE_LLM_FOR_AI_SEARCH ? null : heuristicPlan
    aiPlannerCache.set(plannerCacheKey, {
      expiresAt: Date.now() + 60_000,
      plan: fallbackPlan,
    })
    return fallbackPlan
  }

  const languageModel = resolveLanguageModel(provider, apiKey, model)
  try {
    const schemaContext = buildPlannerSchemaContext()
    const toolCatalog = formatAiToolCatalogForPrompt()
    const result = await generateText({
      model: languageModel,
      system: AGENT_QUERY_PLANNER_SYSTEM_PROMPT,
      prompt: `Question:\n${query}\n\nAvailable semantic datasets:\n${schemaContext}\n\nAvailable tools:\n${toolCatalog}`,
      temperature: 0,
      maxOutputTokens: 360,
      timeout: REQUEST_TIMEOUT_MS,
    })

    const planned = parseQueryAgentPlan(result.text, query, fallbackLimit) ?? (REQUIRE_LLM_FOR_AI_SEARCH ? null : heuristicPlan)
    aiPlannerCache.set(plannerCacheKey, {
      expiresAt: Date.now() + 60_000,
      plan: planned,
    })
    return planned
  } catch (error) {
    console.error("Agent query planner failed", error)
    const fallbackPlan = REQUIRE_LLM_FOR_AI_SEARCH ? null : heuristicPlan
    aiPlannerCache.set(plannerCacheKey, {
      expiresAt: Date.now() + 30_000,
      plan: fallbackPlan,
    })
    return fallbackPlan
  }
}

export function toStructuredIntentFromAgent(plan: QueryAgentPlan): StructuredIntent {
  const entity = ENTITY_INTENTS.find((item) => item.type === plan.entityType)
  return {
    kind: "structured",
    operation: "list",
    entityType: plan.entityType,
    entityLabel: entity?.label ?? formatEntityType(plan.entityType).toLowerCase(),
    entityTokens: entity?.tokens ?? [plan.entityType],
    statuses: plan.statuses,
    textQuery: plan.textQuery,
    limit: plan.limit,
  }
}

export function toAnalyticsIntentFromAgent(plan: QueryAgentPlan): AnalyticsIntent {
  return {
    kind: "analytics",
    operation: "aggregate",
    entityType: plan.entityType,
    metric: plan.metric,
    groupBy: plan.groupBy,
    statuses: plan.statuses,
    textQuery: plan.textQuery,
    projectName: plan.projectName,
    dateRangeDays: plan.dateRangeDays,
    limit: plan.limit,
  }
}

function parseQueryDomainClassification(raw: string): QueryDomainClassification | null {
  const candidate = cleanJsonCandidate(raw)
  const segments = [candidate]
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    segments.push(raw.slice(start, end + 1).trim())
  }

  for (const segment of segments) {
    try {
      const parsed = JSON.parse(segment) as {
        domain?: unknown
        confidence?: unknown
        reason?: unknown
      }

      const domain =
        typeof parsed.domain === "string" ? (parsed.domain.trim().toLowerCase() as QueryDomain) : undefined
      if (domain !== "org" && domain !== "general" && domain !== "social") {
        continue
      }

      const confidence =
        typeof parsed.confidence === "string"
          ? (parsed.confidence.trim().toLowerCase() as QueryDomainConfidence)
          : "low"
      const normalizedConfidence: QueryDomainConfidence =
        confidence === "low" || confidence === "medium" || confidence === "high" ? confidence : "low"
      const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "No reason provided."

      return {
        domain,
        confidence: normalizedConfidence,
        reason,
      }
    } catch {
      continue
    }
  }

  return null
}

async function classifyQueryDomainWithLlm(query: string, provider: AiProvider, model: string): Promise<QueryDomainClassification | null> {
  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey) return null

  const languageModel = resolveLanguageModel(provider, apiKey, model)
  try {
    const result = await generateText({
      model: languageModel,
      system: QUERY_DOMAIN_CLASSIFIER_SYSTEM_PROMPT,
      prompt: `Question:\n${query}`,
      temperature: 0,
      maxOutputTokens: 120,
      timeout: REQUEST_TIMEOUT_MS,
    })
    return parseQueryDomainClassification(result.text)
  } catch (error) {
    console.error("Query domain classification failed", error)
    return null
  }
}

export async function resolveAssistantMode(
  requestedMode: "org" | "general" | undefined,
  flags: AiSearchRuntimeFlags,
  query: string,
  provider: AiProvider,
  model: string,
): Promise<"org" | "general"> {
  if (requestedMode === "org") {
    return "org"
  }

  if (requestedMode === "general") {
    return "general"
  }

  // Auto mode: keep org-grounded behavior unless the prompt is clearly general.
  if (isGreetingOrSmallTalkQuery(query)) {
    return "general"
  }

  const hasEntityMentions = detectEntityMentions(query).length > 0
  const hasOrgContextHint = ORG_CONTEXT_HINT_RE.test(query)
  const hasBusinessMetricHint = ORG_BUSINESS_METRIC_HINT_RE.test(query)
  const hasSubjectHint = ORG_SUBJECT_HINT_RE.test(query)
  const hasRelativeTimeHint = CLARIFICATION_TIME_RANGE_RE.test(query)

  if (hasEntityMentions || hasOrgContextHint) {
    return "org"
  }
  if (hasBusinessMetricHint && (hasSubjectHint || hasRelativeTimeHint)) {
    return "org"
  }

  const classified = await classifyQueryDomainWithLlm(query, provider, model)
  if (classified?.domain === "org") {
    return "org"
  }
  if (classified?.domain === "general" || classified?.domain === "social") {
    return "general"
  }

  if (GENERAL_KNOWLEDGE_HINT_RE.test(query)) {
    return "general"
  }
  if (isLikelyGeneralNonOrgQuery(query)) {
    return "general"
  }

  return "org"
}

export function detectEntityMentions(query: string): SearchEntityType[] {
  const lower = normalizeSpellingHints(query).toLowerCase()
  const matches: SearchEntityType[] = []
  for (const entity of ENTITY_INTENTS) {
    if (entity.aliases.some((pattern) => pattern.test(lower))) {
      if (!matches.includes(entity.type)) {
        matches.push(entity.type)
      }
    }
  }

  const schemaEntities = Array.from(
    new Set<SearchEntityType>([
      ...(Object.keys(COUNT_QUERY_CONFIGS) as SearchEntityType[]),
      ...(Object.keys(ANALYTICS_ENTITY_CONFIGS) as SearchEntityType[]),
    ]),
  )
  for (const entityType of schemaEntities) {
    if (matches.includes(entityType)) continue
    const explicitPattern = new RegExp(`\\b${entityType.replace(/_/g, "[ _-]?")}s?\\b`, "i")
    if (explicitPattern.test(lower)) {
      matches.push(entityType)
      continue
    }

    const parts = entityType.split("_").filter((part) => part.length > 0)
    if (parts.length === 0) continue
    const phrasePattern = new RegExp(`\\b${parts.join("[\\s_-]+")}s?\\b`, "i")
    if (phrasePattern.test(lower)) {
      matches.push(entityType)
    }
  }

  return matches
}

export function isGreetingOrSmallTalkQuery(query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return false
  if (SOCIAL_GREETING_RE.test(normalized)) return true
  if (SMALL_TALK_RE.test(normalized)) return true
  return false
}

export function isLikelyGeneralNonOrgQuery(query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return false
  if (isGreetingOrSmallTalkQuery(normalized)) return true
  if (ASSISTANT_META_HINT_RE.test(normalized) && !ORG_CONTEXT_HINT_RE.test(normalized)) return true
  if (detectEntityMentions(normalized).length > 0) return false
  if (ORG_CONTEXT_HINT_RE.test(normalized)) return false
  if (ORG_BUSINESS_METRIC_HINT_RE.test(normalized) && (ORG_SUBJECT_HINT_RE.test(normalized) || CLARIFICATION_TIME_RANGE_RE.test(normalized))) {
    return false
  }
  if (GENERAL_KNOWLEDGE_HINT_RE.test(normalized)) return true
  if (GENERAL_QUESTION_START_RE.test(normalized)) return true
  if (normalized.endsWith("?") && normalized.split(/\s+/).length <= 10) return true
  return false
}

export function isAssistantRuntimeInfoQuery(query: string) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return false
  if (!ASSISTANT_META_HINT_RE.test(normalized)) return false
  return ASSISTANT_RUNTIME_INFO_RE.test(normalized)
}

export function buildGreetingResponse(query: string) {
  const lower = query.trim().toLowerCase()
  if (/\b(thanks|thank you)\b/.test(lower)) {
    return "You’re welcome. Ask me anything about your company data, or ask a general question."
  }
  if (/\b(bye|goodbye)\b/.test(lower)) {
    return "Any time. I’m here whenever you need help with company data or quick questions."
  }
  if (/\bwhat can you do\b/.test(lower)) {
    return "I can answer company questions, find records, summarize status, and draft actions like tasks or messages."
  }
  return "Hi. I can help with company questions like invoices, projects, approvals, and tasks, or answer general questions."
}

export function requiresClarification({
  query,
  mode,
  sessionContext,
}: {
  query: string
  mode: "org" | "general"
  sessionContext: string
}) {
  if (mode !== "org") return null
  const normalized = query.trim()
  if (!normalized) return null

  const mentionedEntities = detectEntityMentions(normalized)
  const asksBroadAnalysis = NON_STRUCTURED_HINT_RE.test(normalized.toLowerCase()) || CROSS_DOMAIN_INTENT_RE.test(normalized)
  const mentionsTimeRange = CLARIFICATION_TIME_RANGE_RE.test(normalized)

  if (CLARIFICATION_SCOPE_PRONOUN_RE.test(normalized) && sessionContext.trim().length === 0) {
    return "Can you clarify what “that” refers to and which project or records you want me to use?"
  }

  if (asksBroadAnalysis && mentionedEntities.length === 0 && !mentionsTimeRange) {
    return "Do you want this org-wide, or for a specific project and time range?"
  }

  return null
}
