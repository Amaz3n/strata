import "server-only"

import { stepCountIs, streamText } from "ai"

import { askAiSearch, type AiSearchTraceEvent, type AskAiSearchResponse } from "@/lib/services/ai-search"
import { getOrgAiSearchConfigFromContext, type AiConfigSource, type AiProvider } from "@/lib/services/ai-config"
import { createAiAssistantTools } from "@/lib/services/ai-assistant/tools"
import {
  buildToolContext,
  createAssistantToolState,
  mapCitation,
  mapRelatedResult,
} from "@/lib/services/ai-assistant/state"
import { retrieveHybridResults } from "@/lib/services/ai-search/retrieval"
import {
  appendAiSearchMessage,
  ensureAiSearchSession,
  loadAiSearchSessionContext,
} from "@/lib/services/ai-search/sessions"
import { recordAiSearchEvent } from "@/lib/services/ai-search/telemetry"
import { getAiSearchRuntimeFlags } from "@/lib/services/ai-search-flags"
import { getApiKeyForProvider, resolveLanguageModel } from "@/lib/services/ai-search/llm"
import { requireOrgContext } from "@/lib/services/context"
import type { SearchResult } from "@/lib/services/search"

const MAX_QUERY_CHARS = 1_200
const DEFAULT_LIMIT = 20
const MAX_CONTEXT_SOURCES = 12
const MEMORY_FACT_LIMIT = 8
const STEP_TIMEOUT_MS = 10_000
const TOTAL_TIMEOUT_MS = 25_000

type StreamPayload = {
  query: string
  limit?: number
  sessionId?: string
  mode?: "org" | "general"
  currentProjectId?: string | null
}

type StreamEventName = "trace" | "delta" | "result" | "error"

type StreamEmitter = (event: StreamEventName, payload: unknown) => void | Promise<void>

function clampLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(50, Math.floor(value ?? DEFAULT_LIMIT)))
}

function nowIso() {
  return new Date().toISOString()
}

async function emitTrace(emit: StreamEmitter, payload: Omit<AiSearchTraceEvent, "timestamp">) {
  await emit("trace", {
    ...payload,
    thought: payload.thought ?? payload.detail ?? payload.label,
    timestamp: nowIso(),
  } satisfies AiSearchTraceEvent)
}

function formatEntityType(type: string) {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function formatResultContext(results: SearchResult[]) {
  if (results.length === 0) return ""
  return [
    "Speculative retrieval context. These are candidate org records; use tools if exact metrics or broader evidence are needed.",
    ...results.slice(0, MAX_CONTEXT_SOURCES).map((result, index) => {
      const lines = [
        `[S${index + 1}] ${formatEntityType(result.type)}: ${result.title}`,
        result.subtitle ? `Details: ${result.subtitle}` : "",
        result.description ? `Description: ${result.description}` : "",
        result.project_name ? `Project: ${result.project_name}` : "",
        result.updated_at ? `Updated: ${result.updated_at}` : "",
        `Href: ${result.href}`,
      ].filter(Boolean)
      return lines.join("\n")
    }),
  ].join("\n\n")
}

function buildSystemPrompt(assistantMode: "org" | "general") {
  if (assistantMode === "general") {
    return `You are a practical assistant for construction teams.
- Answer directly and concisely.
- If the user asks for company-specific facts, say you cannot verify them without org data context.
- Do not fabricate org-specific records, financial values, names, dates, statuses, or links.
- Return plain text only.`
  }

  return `You are Arc's org data assistant for construction teams.
- Use tools for organization records, financial metrics, analytics, and action drafts.
- Financial numbers must come from finance_metric or run_analytics tool output. Do not compute or invent business figures.
- Tables, charts, reports, citations, and proposed actions are assembled by the server. Do not emit JSON, markdown tables, chart payloads, or fake source ids.
- If an answer is not grounded in a tool result or provided retrieval context, say what is missing.
- Mutations must stay as approval-required action drafts. Never claim an action was executed unless a tool result says it was.
- If required input is missing, ask one clear follow-up question.
- Keep answers concise and operational.`
}

function buildPrompt({
  query,
  sessionContext,
  currentProjectId,
  speculativeContext,
}: {
  query: string
  sessionContext?: string
  currentProjectId?: string | null
  speculativeContext?: string
}) {
  return [
    currentProjectId ? `Current project scope id: ${currentProjectId}` : "",
    sessionContext ? `Recent conversation:\n${sessionContext}` : "",
    speculativeContext,
    `User question:\n${query}`,
  ]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join("\n\n")
}

function buildLlmUnavailableResponse({
  assistantMode,
  provider,
  model,
  configSource,
  sessionId,
}: {
  assistantMode: "org" | "general"
  provider: AiProvider
  model: string
  configSource: AiConfigSource
  sessionId?: string
}): AskAiSearchResponse {
  return {
    answer:
      "I couldn't reach the configured LLM, so I did not generate a fallback answer. Please restart the model endpoint and try again.",
    citations: [],
    relatedResults: [],
    generatedAt: nowIso(),
    assistantMode,
    mode: "fallback",
    provider,
    model,
    configSource,
    confidence: "low",
    missingData: ["Configured LLM was unavailable or timed out."],
    actions: [],
    sessionId,
  }
}

function buildFinalResponse({
  answer,
  state,
  assistantMode,
  provider,
  model,
  configSource,
  sessionId,
}: {
  answer: string
  state: ReturnType<typeof createAssistantToolState>
  assistantMode: "org" | "general"
  provider: AiProvider
  model: string
  configSource: AiConfigSource
  sessionId: string
}): AskAiSearchResponse {
  const relatedResults = state.relatedResults.slice(0, Math.max(8, MAX_CONTEXT_SOURCES))
  const citations = assistantMode === "org" ? relatedResults.slice(0, MAX_CONTEXT_SOURCES).map(mapCitation) : []
  const fallbackActionAnswer =
    state.actions.length > 0
      ? "I drafted an action for you. Review it below and execute it only when you are ready."
      : ""
  const fallbackAnswer =
    answer.trim() ||
    fallbackActionAnswer ||
    (state.toolSummaries.length > 0
      ? state.toolSummaries[state.toolSummaries.length - 1] ?? ""
      : "I could not produce a grounded answer for that request.")
  const hasGrounding = citations.length > 0 || Boolean(state.artifact) || state.actions.length > 0

  return {
    answer: fallbackAnswer,
    citations,
    relatedResults: relatedResults.slice(0, 8).map(mapRelatedResult),
    generatedAt: nowIso(),
    assistantMode,
    mode: answer.trim() ? "llm" : "fallback",
    provider,
    model,
    configSource,
    confidence:
      state.missingData.length > 0
        ? "low"
        : hasGrounding
          ? "high"
          : assistantMode === "general"
            ? "medium"
            : "low",
    missingData:
      assistantMode === "general"
        ? ["This response is not grounded in company-record citations."]
        : state.missingData,
    artifact: state.artifact,
    exports: state.exports,
    actions: state.actions,
    sessionId,
  }
}

function toolLabel(toolName: string) {
  switch (toolName) {
    case "search_records":
      return "Searching records"
    case "get_record":
      return "Loading record"
    case "finance_metric":
      return "Running finance metric"
    case "run_analytics":
      return "Running analytics"
    case "create_task":
      return "Drafting task action"
    case "ask_user":
      return "Preparing follow-up"
    default:
      return `Running ${toolName}`
  }
}

function summarizeToolOutput(output: unknown) {
  if (!output || typeof output !== "object") return undefined
  const record = output as Record<string, unknown>
  if (typeof record.narrative_summary === "string") return record.narrative_summary
  return undefined
}

export async function streamAiAssistant({
  payload,
  emit,
  abortSignal,
}: {
  payload: StreamPayload
  emit: StreamEmitter
  abortSignal?: AbortSignal
}) {
  const query = payload.query.trim()
  const startedAt = Date.now()

  await emitTrace(emit, {
    id: "stream-open",
    status: "started",
    label: "Session started",
    detail: "Secure stream is active and preparing the assistant loop.",
  })

  if (!query) {
    await emit("result", {
      answer: "Ask a question about projects, tasks, files, invoices, or contacts in your org.",
      citations: [],
      relatedResults: [],
      generatedAt: nowIso(),
      assistantMode: "org",
      mode: "fallback",
      confidence: "low",
      missingData: ["No question was provided."],
      actions: [],
    } satisfies AskAiSearchResponse)
    return
  }

  if (query.length > MAX_QUERY_CHARS) {
    await emit("error", {
      message: `Query is too long. Keep it under ${MAX_QUERY_CHARS} characters.`,
    })
    return
  }

  const context = await requireOrgContext()
  const [aiConfig, runtimeFlags] = await Promise.all([
    getOrgAiSearchConfigFromContext(context),
    getAiSearchRuntimeFlags(context),
  ])

  if (!runtimeFlags.enabled) {
    await emit("error", { message: "AI search is turned off for this organization." })
    return
  }

  if (!runtimeFlags.agentHarness) {
    const legacyResponse = await askAiSearch(query, {
      limit: payload.limit,
      sessionId: payload.sessionId,
      mode: payload.mode,
      currentProjectId: payload.currentProjectId,
      onTrace: (event) => emit("trace", event),
    })
    await emit("result", legacyResponse)
    return
  }

  const assistantMode = payload.mode ?? "org"
  const limit = clampLimit(payload.limit)
  const sessionId = await ensureAiSearchSession(context, assistantMode, payload.sessionId)
  const sessionContext = runtimeFlags.conversationMemory
    ? await loadAiSearchSessionContext({
        context,
        sessionId,
        memoryFactLimit: MEMORY_FACT_LIMIT,
      })
    : ""

  await appendAiSearchMessage(context, sessionId, "user", query, {
    assistantMode,
    harness: "tool_loop",
  })

  await emitTrace(emit, {
    id: "context-ready",
    status: "completed",
    label: "Org context secured",
    detail:
      assistantMode === "org"
        ? "All tool access is constrained to your organization."
        : "General mode is active, so org tools are disabled.",
  })

  const state = createAssistantToolState()
  let speculativeResults: SearchResult[] = []
  if (assistantMode === "org") {
    await emitTrace(emit, {
      id: "speculative-retrieval",
      status: "running",
      label: "Checking likely records",
      detail: "Starting a fast retrieval pass before the model chooses tools.",
    })
    speculativeResults = await retrieveHybridResults({
      context,
      query,
      entityTypes: [],
      filters: payload.currentProjectId ? { projectId: payload.currentProjectId } : {},
      limit: Math.min(limit, 8),
      enableHybrid: runtimeFlags.hybridRetrieval,
    })
    if (speculativeResults.length > 0) {
      state.relatedResults.push(...speculativeResults)
    }
    await emitTrace(emit, {
      id: "speculative-retrieval",
      status: "completed",
      label: "Likely records checked",
      detail: `${speculativeResults.length.toLocaleString()} candidate record${
        speculativeResults.length === 1 ? "" : "s"
      } loaded.`,
    })
  }

  const apiKey = getApiKeyForProvider(aiConfig.provider)
  if (!apiKey) {
    await emitTrace(emit, {
      id: "llm-unavailable",
      status: "warning",
      label: "LLM unavailable",
      detail: "No API key is configured for the active provider.",
    })
    const response = buildLlmUnavailableResponse({
      assistantMode,
      provider: aiConfig.provider,
      model: aiConfig.model,
      configSource: aiConfig.source,
      sessionId,
    })
    await emit("result", response)
    await recordAiSearchEvent({
      context,
      sessionId,
      query,
      assistantMode,
      success: false,
      error: "llm_unavailable",
      plan: { harness: "tool_loop" },
      metrics: { agent_harness: true, llm_unavailable: true },
      citationsCount: 0,
      resultsCount: 0,
      latencyMs: Date.now() - startedAt,
    })
    return
  }

  const model = resolveLanguageModel(aiConfig.provider, apiKey, aiConfig.model)
  const tools =
    assistantMode === "org"
      ? createAiAssistantTools({
          context,
          state,
          sessionId,
          defaultLimit: limit,
          enableHybridRetrieval: runtimeFlags.hybridRetrieval,
          allowMutations: true,
        })
      : undefined

  let text = ""
  let streamFailed = false

  try {
    const result = streamText({
      model,
      system: buildSystemPrompt(assistantMode),
      prompt: buildPrompt({
        query,
        sessionContext,
        currentProjectId: payload.currentProjectId,
        speculativeContext: assistantMode === "org" ? formatResultContext(speculativeResults) : "",
      }),
      tools,
      stopWhen: stepCountIs(6),
      temperature: assistantMode === "org" ? 0.2 : 0.4,
      maxOutputTokens: 800,
      abortSignal,
      timeout: {
        stepMs: STEP_TIMEOUT_MS,
        totalMs: TOTAL_TIMEOUT_MS,
      },
      experimental_telemetry: {
        isEnabled: true,
        functionId: "ai-search.tool-loop",
        metadata: {
          orgId: context.orgId,
          assistantMode,
          provider: aiConfig.provider,
          model: aiConfig.model,
        },
      },
    })

    for await (const part of result.fullStream) {
      if (abortSignal?.aborted) break

      if (part.type === "text-delta") {
        text += part.text
        await emit("delta", { text: part.text })
        continue
      }

      if (part.type === "tool-call") {
        await emitTrace(emit, {
          id: `tool-call-${part.toolCallId}`,
          status: "running",
          label: toolLabel(part.toolName),
          detail: "The model selected a typed server tool.",
        })
        continue
      }

      if (part.type === "tool-result") {
        const summary = summarizeToolOutput(part.output)
        await emitTrace(emit, {
          id: `tool-result-${part.toolCallId}`,
          status: "completed",
          label: `${toolLabel(part.toolName)} complete`,
          detail: summary ?? "Tool execution completed.",
        })
        if (summary) {
          await appendAiSearchMessage(context, sessionId, "system", summary, {
            assistantMode,
            harness: "tool_loop",
            toolName: part.toolName,
            toolCallId: part.toolCallId,
            kind: "tool_result",
          })
        }
        continue
      }

      if (part.type === "error") {
        streamFailed = true
        await emitTrace(emit, {
          id: "stream-error",
          status: "warning",
          label: "Model stream warning",
          detail: part.error instanceof Error ? part.error.message : "The model stream reported an error.",
        })
      }
    }
  } catch (error) {
    streamFailed = true
    await emitTrace(emit, {
      id: "stream-failed",
      status: "warning",
      label: "Model stream failed",
      detail: error instanceof Error ? error.message : "The assistant stream failed.",
    })
  }

  const toolContext = buildToolContext(state)
  if (!text.trim() && toolContext) {
    text = state.toolSummaries[state.toolSummaries.length - 1] ?? ""
  }

  const response = buildFinalResponse({
    answer: text,
    state,
    assistantMode,
    provider: aiConfig.provider,
    model: aiConfig.model,
    configSource: aiConfig.source,
    sessionId,
  })

  await appendAiSearchMessage(context, sessionId, "assistant", response.answer, {
    assistantMode,
    harness: "tool_loop",
    mode: response.mode,
    provider: response.provider,
    model: response.model,
  })

  await emitTrace(emit, {
    id: "done",
    status: streamFailed ? "warning" : "completed",
    label: "Answer ready",
    detail:
      state.toolRunCount > 0
        ? `Completed with ${state.toolRunCount.toLocaleString()} tool step${
            state.toolRunCount === 1 ? "" : "s"
          }.`
        : "Completed without tool calls.",
  })
  await emit("result", response)

  await recordAiSearchEvent({
    context,
    sessionId,
    query,
    assistantMode,
    success: !streamFailed,
    error: streamFailed ? "stream_failed" : undefined,
    plan: {
      harness: "tool_loop",
      tool_steps: state.toolRunCount,
      artifact: response.artifact?.kind ?? null,
      actions: response.actions?.length ?? 0,
    },
    metrics: {
      agent_harness: true,
      hybrid_retrieval: runtimeFlags.hybridRetrieval,
      conversation_memory: runtimeFlags.conversationMemory,
      speculative_results: speculativeResults.length,
      tool_steps: state.toolRunCount,
      stream_failed: streamFailed,
    },
    citationsCount: response.citations.length,
    resultsCount: response.relatedResults.length,
    latencyMs: Date.now() - startedAt,
  })
}
