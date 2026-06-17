import "server-only"

import { randomUUID } from "node:crypto"

import type { requireOrgContext } from "@/lib/services/context"

type ResolvedOrgContext = Awaited<ReturnType<typeof requireOrgContext>>

export async function ensureAiSearchSession(
  context: ResolvedOrgContext,
  mode: "org" | "general",
  sessionId?: string,
): Promise<string> {
  const trimmed = typeof sessionId === "string" ? sessionId.trim() : ""
  if (trimmed) {
    const { data, error } = await context.supabase
      .from("ai_search_sessions")
      .select("id,mode")
      .eq("id", trimmed)
      .eq("org_id", context.orgId)
      .eq("user_id", context.userId)
      .maybeSingle()

    if (!error && data?.id) {
      const updates: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      }
      if (data.mode !== mode) {
        updates.mode = mode
      }
      await context.supabase
        .from("ai_search_sessions")
        .update(updates)
        .eq("id", data.id)
        .eq("org_id", context.orgId)
        .eq("user_id", context.userId)
      return data.id
    }
  }

  const { data, error } = await context.supabase
    .from("ai_search_sessions")
    .insert({
      org_id: context.orgId,
      user_id: context.userId,
      mode,
    })
    .select("id")
    .single()

  if (error || !data?.id) {
    console.error("Failed to create AI search session", error)
    return randomUUID()
  }

  return data.id
}

export async function appendAiSearchMessage(
  context: ResolvedOrgContext,
  sessionId: string,
  role: "user" | "assistant" | "system",
  content: string,
  metadata?: Record<string, unknown>,
) {
  const trimmed = content.trim()
  if (!trimmed) return
  await context.supabase.from("ai_search_messages").insert({
    session_id: sessionId,
    org_id: context.orgId,
    user_id: context.userId,
    role,
    content: trimmed,
    metadata: metadata ?? {},
  })
}

export function normalizeMemoryFact(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.?!;:]+$/g, "")
}

export async function loadAiSearchSessionContext({
  context,
  sessionId,
  memoryFactLimit,
}: {
  context: ResolvedOrgContext
  sessionId: string
  memoryFactLimit: number
}): Promise<string> {
  const { data, error } = await context.supabase
    .from("ai_search_messages")
    .select("role,content,metadata")
    .eq("session_id", sessionId)
    .eq("org_id", context.orgId)
    .eq("user_id", context.userId)
    .order("created_at", { ascending: false })
    .limit(20)

  if (error || !Array.isArray(data) || data.length === 0) {
    return ""
  }

  const memoryFacts = new Set<string>()
  for (const item of data) {
    const metadata = item && typeof item === "object" ? (item as { metadata?: unknown }).metadata : undefined
    if (!metadata || typeof metadata !== "object") continue
    const factList = (metadata as { memoryFacts?: unknown }).memoryFacts
    if (!Array.isArray(factList)) continue
    for (const fact of factList) {
      if (typeof fact !== "string") continue
      const normalized = normalizeMemoryFact(fact)
      if (normalized) memoryFacts.add(normalized)
      if (memoryFacts.size >= memoryFactLimit) break
    }
    if (memoryFacts.size >= memoryFactLimit) break
  }

  const lines = data
    .slice()
    .reverse()
    .slice(-8)
    .map((item) => {
      const role = typeof item.role === "string" ? item.role : "user"
      const content = typeof item.content === "string" ? item.content.trim() : ""
      if (!content) return null
      return `${role.toUpperCase()}: ${content}`
    })
    .filter((item): item is string => Boolean(item))

  if (lines.length === 0 && memoryFacts.size === 0) return ""

  const memoryBlock =
    memoryFacts.size > 0
      ? `Persistent memory facts:\n${Array.from(memoryFacts)
          .map((fact) => `- ${fact}`)
          .join("\n")}`
      : ""
  return [memoryBlock, lines.join("\n")].filter((segment) => segment.trim().length > 0).join("\n\n")
}
