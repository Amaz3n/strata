import "server-only"

import { generateText } from "ai"
import type { AiProvider } from "@/lib/services/ai-config"
import {
  getApiKeyForProvider,
  resolveLanguageModel,
} from "@/lib/services/ai-search/llm"

const INTENT_ROUTER_TIMEOUT_MS = 8_000
const INTENT_ROUTER_CACHE_TTL_MS = 60_000
const INTENT_ROUTER_MAX_TOKENS = 420
const INTENT_ROUTER_VERSION = "2026-06-17-unified-router-v1"

export type AiSearchRouterMode = "org" | "general" | "social"
export type AiSearchRouterIntent =
  | "answer_question"
  | "search_records"
  | "aggregate_data"
  | "analyze_data"
  | "lookup_attribute"
  | "start_workflow"
  | "unknown"

export type UnifiedIntentRoute = {
  mode: AiSearchRouterMode
  intent: AiSearchRouterIntent
  workflowKey?: "invoices.create"
  entityTypes: string[]
  slots: Record<string, unknown>
  confidence: number
  needsClarification: boolean
  clarificationQuestion?: string
  reason: string
}

const DEFAULT_ROUTE: UnifiedIntentRoute = {
  mode: "org",
  intent: "unknown",
  entityTypes: [],
  slots: {},
  confidence: 0,
  needsClarification: false,
  reason: "No route produced.",
}

const routerCache = new Map<string, { expiresAt: number; route: UnifiedIntentRoute | null }>()

const UNIFIED_INTENT_ROUTER_SYSTEM_PROMPT = `You are the first-pass intent and slot router for a construction business workspace assistant.
Return strict JSON only:
{
  "mode": "org" | "general" | "social",
  "intent": "answer_question" | "search_records" | "aggregate_data" | "analyze_data" | "lookup_attribute" | "start_workflow" | "unknown",
  "workflowKey": "invoices.create" | null,
  "entityTypes": string[],
  "slots": Record<string, unknown>,
  "confidence": number,
  "needsClarification": boolean,
  "clarificationQuestion": string | null,
  "reason": string
}

Supported workflow:
- invoices.create: use when the user wants to create, draft, prepare, prep, make, start, generate, send, email, bill, or get ready to send an invoice.

Invoice workflow slot hints:
- projectHint: project/job name if mentioned.
- customerHint: customer/contact/company if mentioned.
- deliveryMode: "email_now" only if the user clearly wants it sent/emailed now; "save_draft" if they ask to draft, prepare, prep, make, create, or get it ready.
- lineItems: only if explicit service/item, quantity, and price/amount are mentioned.

Analytics/report slot hints:
- For AR aging, A/R aging, accounts receivable aging, aging report, overdue receivables by age, or requests for an AR aging graph/report:
  - intent: "aggregate_data"
  - mode: "org"
  - entityTypes: ["invoice"]
  - slots.groupBy: "aging"
  - slots.metric: "sum_amount"
  - slots.chartType: "bar"
  - slots.reportType: "ar_aging"
- AR aging is invoice-only. Do not add project, task, payment, or other entity types unless the user explicitly asks for a separate comparison.
- Do not classify AR aging reports as invoice creation workflows.

Rules:
- Route by semantic meaning, not exact words. "prep an invoice to send to X", "draft a bill for X", and "get an invoice ready for X" are invoices.create.
- Do not use invoices.create for questions about whether an existing invoice/draw/deposit/payment was paid; those are answer_question or search_records.
- mode "org" is for company/workspace data, records, workflows, projects, invoices, customers, budgets, payments, and operations.
- mode "general" is for external/general knowledge not requiring company records.
- mode "social" is for greetings, thanks, and small talk.
- Use needsClarification only when the next step cannot safely run. Missing workflow slots are allowed because the workflow will ask follow-up questions.
- confidence must be 0 to 1. Keep reason short.`

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

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const candidates = [cleanJsonCandidate(raw)]
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start >= 0 && end > start) {
    candidates.push(raw.slice(start, end + 1).trim())
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      continue
    }
  }
  return null
}

function normalizeMode(value: unknown): AiSearchRouterMode {
  if (value === "general" || value === "social" || value === "org") return value
  return "org"
}

function normalizeIntent(value: unknown): AiSearchRouterIntent {
  if (
    value === "answer_question" ||
    value === "search_records" ||
    value === "aggregate_data" ||
    value === "analyze_data" ||
    value === "lookup_attribute" ||
    value === "start_workflow" ||
    value === "unknown"
  ) {
    return value
  }
  return "unknown"
}

function normalizeConfidence(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function normalizeText(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeSlots(value: unknown, currentProjectId?: string | null) {
  const slots: Record<string, unknown> = {}
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>
    for (const key of ["projectHint", "customerHint"]) {
      const text = normalizeText(raw[key])
      if (text) slots[key] = text
    }
    if (raw.deliveryMode === "email_now" || raw.deliveryMode === "save_draft") {
      slots.deliveryMode = raw.deliveryMode
    }
    if (raw.groupBy === "none" || raw.groupBy === "status" || raw.groupBy === "project" || raw.groupBy === "month" || raw.groupBy === "aging") {
      slots.groupBy = raw.groupBy
    }
    if (raw.metric === "count" || raw.metric === "sum_amount" || raw.metric === "avg_amount") {
      slots.metric = raw.metric
    }
    if (
      raw.chartType === "bar" ||
      raw.chartType === "horizontalBar" ||
      raw.chartType === "line" ||
      raw.chartType === "area" ||
      raw.chartType === "pie" ||
      raw.chartType === "donut" ||
      raw.chartType === "stackedBar"
    ) {
      slots.chartType = raw.chartType
    }
    if (raw.reportType === "ar_aging") {
      slots.reportType = raw.reportType
    }
    if (Array.isArray(raw.lineItems)) {
      const lineItems = raw.lineItems
        .map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return null
          const record = item as Record<string, unknown>
          const description = normalizeText(record.description)
          const quantity = typeof record.quantity === "number" && Number.isFinite(record.quantity) ? record.quantity : 1
          const unitAmountCents =
            typeof record.unitAmountCents === "number" && Number.isFinite(record.unitAmountCents)
              ? Math.round(record.unitAmountCents)
              : null
          if (!description || unitAmountCents === null || unitAmountCents <= 0) return null
          return { description, quantity: Math.max(1, quantity), unitAmountCents }
        })
        .filter((item): item is { description: string; quantity: number; unitAmountCents: number } => Boolean(item))
      if (lineItems.length > 0) slots.lineItems = lineItems.slice(0, 12)
    }
  }
  if (currentProjectId) slots.pageProjectId = currentProjectId
  return slots
}

function normalizeEntityTypes(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => normalizeText(item)?.toLowerCase().replace(/\s+/g, "_"))
    .filter((item): item is string => Boolean(item))
    .slice(0, 6)
}

function normalizeRoute(parsed: Record<string, unknown>, currentProjectId?: string | null): UnifiedIntentRoute {
  const intent = normalizeIntent(parsed.intent)
  const mode = normalizeMode(parsed.mode)
  const workflowKey = parsed.workflowKey === "invoices.create" && intent === "start_workflow" ? "invoices.create" : undefined
  const slots = normalizeSlots(parsed.slots, currentProjectId)
  const confidence = normalizeConfidence(parsed.confidence)
  const needsClarification = parsed.needsClarification === true
  const clarificationQuestion = normalizeText(parsed.clarificationQuestion)
  const reason = normalizeText(parsed.reason) ?? DEFAULT_ROUTE.reason

  return {
    mode,
    intent,
    workflowKey,
    entityTypes: normalizeEntityTypes(parsed.entityTypes),
    slots,
    confidence,
    needsClarification,
    clarificationQuestion,
    reason,
  }
}

export function pruneUnifiedIntentRouterCache(now = Date.now()) {
  for (const [key, value] of routerCache.entries()) {
    if (value.expiresAt <= now) {
      routerCache.delete(key)
    }
  }
}

export async function routeUnifiedIntent({
  query,
  provider,
  model,
  requestedMode,
  currentProjectId,
}: {
  query: string
  provider: AiProvider
  model: string
  requestedMode?: "org" | "general"
  currentProjectId?: string | null
}): Promise<UnifiedIntentRoute | null> {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return null

  const cacheKey = `${INTENT_ROUTER_VERSION}:${provider}:${model}:${requestedMode ?? "auto"}:${currentProjectId ?? "none"}:${normalizedQuery.toLowerCase()}`
  const cached = routerCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.route
  }

  const apiKey = getApiKeyForProvider(provider)
  if (!apiKey) {
    routerCache.set(cacheKey, { expiresAt: Date.now() + INTENT_ROUTER_CACHE_TTL_MS, route: null })
    return null
  }

  const languageModel = resolveLanguageModel(provider, apiKey, model)
  try {
    const result = await generateText({
      model: languageModel,
      system: UNIFIED_INTENT_ROUTER_SYSTEM_PROMPT,
      prompt: [
        `User request:\n${normalizedQuery}`,
        requestedMode ? `User-selected mode: ${requestedMode}` : "User-selected mode: auto",
        currentProjectId ? `Current page project id: ${currentProjectId}` : "",
      ]
        .filter((line) => line.trim().length > 0)
        .join("\n\n"),
      temperature: 0,
      maxOutputTokens: INTENT_ROUTER_MAX_TOKENS,
      timeout: INTENT_ROUTER_TIMEOUT_MS,
    })

    const parsed = parseJsonObject(result.text)
    const route = parsed ? normalizeRoute(parsed, currentProjectId) : null
    routerCache.set(cacheKey, { expiresAt: Date.now() + INTENT_ROUTER_CACHE_TTL_MS, route })
    return route
  } catch (error) {
    console.error("Unified AI intent routing failed", error)
    routerCache.set(cacheKey, { expiresAt: Date.now() + 30_000, route: null })
    return null
  }
}
