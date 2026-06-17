import "server-only"

import type { AiSearchTraceEvent } from "@/lib/services/ai-search"
import type { requireOrgContext } from "@/lib/services/context"

type ResolvedOrgContext = Awaited<ReturnType<typeof requireOrgContext>>

export async function recordAiSearchEvent({
  context,
  sessionId,
  query,
  assistantMode,
  success,
  error,
  plan,
  metrics,
  citationsCount,
  resultsCount,
  latencyMs,
}: {
  context: ResolvedOrgContext
  sessionId: string
  query: string
  assistantMode: "org" | "general"
  success: boolean
  error?: string
  plan?: Record<string, unknown>
  metrics?: Record<string, unknown>
  citationsCount: number
  resultsCount: number
  latencyMs: number
}) {
  try {
    await context.supabase.from("ai_search_events").insert({
      org_id: context.orgId,
      user_id: context.userId,
      session_id: sessionId,
      query,
      assistant_mode: assistantMode,
      success,
      error: error ?? null,
      plan: plan ?? {},
      metrics: metrics ?? {},
      citations_count: citationsCount,
      results_count: resultsCount,
      latency_ms: Math.max(0, Math.round(latencyMs)),
    })
  } catch (eventError) {
    console.error("Failed to persist AI search event", eventError)
  }
}

export async function emitTrace(
  options: { onTrace?: (event: AiSearchTraceEvent) => void | Promise<void> },
  payload: Omit<AiSearchTraceEvent, "timestamp">,
) {
  if (!options.onTrace) return
  const thought =
    payload.thought?.trim() ||
    payload.detail?.trim() ||
    (payload.label.trim().endsWith(".") ? payload.label.trim() : `${payload.label.trim()}.`)
  try {
    await options.onTrace({
      ...payload,
      thought,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("AI trace emission failed", error)
  }
}
