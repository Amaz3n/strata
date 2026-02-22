import "server-only"

import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import { getOrgAiSearchConfigFromContext, type AiProvider } from "@/lib/services/ai-config"
import { requireOrgContext } from "@/lib/services/context"
import { searchEntities, type SearchEntityType, type SearchResult } from "@/lib/services/search"

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

export interface AskAiSearchResponse {
  answer: string
  citations: AiSearchCitation[]
  relatedResults: AiSearchRelatedResult[]
  generatedAt: string
  mode: "llm" | "fallback"
  provider?: AiProvider
  model?: string
  configSource?: "org" | "platform" | "env" | "default"
}

interface AskAiSearchOptions {
  limit?: number
}

type RetrievedSource = {
  sourceId: string
  result: SearchResult
}

type ParsedModelAnswer = {
  answer: string
  citation_ids: string[]
}

type LlmAnswer = {
  answer: string
  citationIds: string[]
  provider: AiProvider
  model: string
}

const BASE_ENTITY_TYPES: SearchEntityType[] = ["project", "task", "file", "contact", "company"]
const FINANCIAL_ENTITY_TYPES: SearchEntityType[] = [
  "invoice",
  "payment",
  "budget",
  "estimate",
  "commitment",
  "change_order",
  "contract",
  "proposal",
]
const DOCUMENT_ENTITY_TYPES: SearchEntityType[] = ["rfi", "submittal", "drawing_set", "drawing_sheet", "file"]
const FIELD_ENTITY_TYPES: SearchEntityType[] = ["task", "schedule_item", "daily_log", "punch_item", "photo"]

const DEFAULT_LIMIT = 20
const MIN_LIMIT = 8
const MAX_LIMIT = 30
const MAX_CONTEXT_SOURCES = 12
const MAX_CITATIONS = 5
const CACHE_TTL_MS = 90_000
const REQUEST_TIMEOUT_MS = 12_000
const LLM_SYSTEM_PROMPT =
  "You are an org data assistant for builders. Only answer from provided sources. If evidence is weak, say what is missing. Return strict JSON with keys: answer (string), citation_ids (string[]). Keep answer concise and actionable."
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "at",
  "be",
  "for",
  "from",
  "how",
  "in",
  "is",
  "of",
  "on",
  "or",
  "please",
  "show",
  "the",
  "to",
  "what",
  "where",
  "which",
  "who",
  "with",
])

const aiAnswerCache = new Map<string, { expiresAt: number; response: AskAiSearchResponse }>()

function clampLimit(limit?: number) {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT
  return Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(limit)))
}

function normalizeQuery(query: string) {
  return query.trim().replace(/\s+/g, " ")
}

function extractRetrievalQuery(query: string) {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9_-]/g, ""))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))

  if (tokens.length === 0) {
    return query
  }

  return tokens.slice(0, 7).join(" ")
}

function pickEntityTypesForQuery(query: string): SearchEntityType[] {
  const lower = query.toLowerCase()
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

function parseModelAnswer(raw: string): ParsedModelAnswer | null {
  const candidates = [cleanJsonCandidate(raw)]
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    candidates.push(raw.slice(start, end + 1).trim())
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        answer?: unknown
        citation_ids?: unknown
      }

      if (typeof parsed.answer !== "string" || !parsed.answer.trim()) {
        continue
      }

      const citationIds = Array.isArray(parsed.citation_ids)
        ? parsed.citation_ids.filter((item): item is string => typeof item === "string")
        : []

      return {
        answer: parsed.answer.trim(),
        citation_ids: citationIds,
      }
    } catch {
      continue
    }
  }

  return null
}

function getApiKeyForProvider(provider: AiProvider) {
  if (provider === "openai") return process.env.OPENAI_API_KEY
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY
}

function buildPrompt(query: string, sources: RetrievedSource[]) {
  const sourceContext = formatSourceContext(sources)
  return `Question:\n${query}\n\nSources:\n${sourceContext}`
}

function resolveLanguageModel(provider: AiProvider, apiKey: string, model: string) {
  const normalizedModel = provider === "google" && model.startsWith("models/") ? model.slice("models/".length) : model

  if (provider === "openai") {
    return createOpenAI({ apiKey })(normalizedModel)
  }

  if (provider === "anthropic") {
    return createAnthropic({ apiKey })(normalizedModel)
  }

  return createGoogleGenerativeAI({ apiKey })(normalizedModel)
}

async function generateAnswerWithLlm(query: string, sources: RetrievedSource[], provider: AiProvider, model: string) {
  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey || sources.length === 0) {
    return null
  }
  const languageModel = resolveLanguageModel(provider, apiKey, model)

  try {
    const result = await generateText({
      model: languageModel,
      system: LLM_SYSTEM_PROMPT,
      prompt: buildPrompt(query, sources),
      temperature: 0.2,
      maxOutputTokens: 700,
      timeout: REQUEST_TIMEOUT_MS,
    })
    const parsed = parseModelAnswer(result.text)
    if (!parsed) {
      return null
    }
    return {
      answer: parsed.answer,
      citationIds: parsed.citation_ids,
      provider,
      model,
    }
  } catch (error) {
    console.error("AI search generation failed", error)
    return null
  }
}

function resolveCitations(sources: RetrievedSource[], citationIds: string[]) {
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]))
  const uniqueIds: string[] = []

  for (const id of citationIds) {
    if (!sourceById.has(id)) continue
    if (uniqueIds.includes(id)) continue
    uniqueIds.push(id)
  }

  const fallbackIds = uniqueIds.length > 0 ? uniqueIds : sources.map((source) => source.sourceId).slice(0, MAX_CITATIONS)
  return fallbackIds
    .slice(0, MAX_CITATIONS)
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source): source is RetrievedSource => Boolean(source))
}

function pruneCache() {
  const now = Date.now()
  for (const [key, value] of aiAnswerCache.entries()) {
    if (value.expiresAt <= now) {
      aiAnswerCache.delete(key)
    }
  }
}

export async function askAiSearch(query: string, options: AskAiSearchOptions = {}): Promise<AskAiSearchResponse> {
  const normalizedQuery = normalizeQuery(query)
  const nowIso = new Date().toISOString()

  if (!normalizedQuery) {
    return {
      answer: "Ask a question about projects, tasks, files, invoices, or contacts in your org.",
      citations: [],
      relatedResults: [],
      generatedAt: nowIso,
      mode: "fallback",
    }
  }

  const context = await requireOrgContext()
  const { orgId, supabase, userId } = context
  const aiConfig = await getOrgAiSearchConfigFromContext(context)
  const limit = clampLimit(options.limit)
  const cacheKey = `${orgId}:${aiConfig.provider}:${aiConfig.model}:${normalizedQuery.toLowerCase()}:${limit}`

  pruneCache()
  const cached = aiAnswerCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.response
  }

  const entityTypes = pickEntityTypesForQuery(normalizedQuery)
  const retrievalQuery = extractRetrievalQuery(normalizedQuery)
  const rawResults = await searchEntities(
    retrievalQuery,
    entityTypes,
    {},
    { limit, sortBy: "updated_at" },
    orgId,
    { orgId, supabase, userId },
  )

  const relatedResults = dedupeResults(rawResults).slice(0, limit)
  const sources: RetrievedSource[] = relatedResults
    .slice(0, MAX_CONTEXT_SOURCES)
    .map((result, index) => ({
      sourceId: `S${index + 1}`,
      result,
    }))

  const llmAnswer = await generateAnswerWithLlm(normalizedQuery, sources, aiConfig.provider, aiConfig.model)
  const citations = resolveCitations(sources, llmAnswer?.citationIds ?? []).map(mapCitation)
  const response: AskAiSearchResponse = {
    answer: llmAnswer?.answer ?? buildFallbackAnswer(normalizedQuery, relatedResults),
    citations,
    relatedResults: relatedResults.slice(0, 8).map(mapRelatedResult),
    generatedAt: nowIso,
    mode: llmAnswer ? "llm" : "fallback",
    provider: llmAnswer?.provider ?? aiConfig.provider,
    model: llmAnswer?.model ?? aiConfig.model,
    configSource: aiConfig.source,
  }

  aiAnswerCache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    response,
  })

  return response
}
