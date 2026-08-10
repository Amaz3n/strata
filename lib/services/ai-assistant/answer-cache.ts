import "server-only"

import {
  buildAnswerCacheKey,
  buildDataVersion,
  isCacheEntryFresh,
  isCacheableQuestion,
  permissionFingerprint,
  DEFAULT_CACHE_TTL_SECONDS,
} from "@/lib/ai/answer-cache-key"
import type { AskAiSearchResponse } from "@/lib/services/ai-search/types"
import { getUserPermissions } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { OrgServiceContext } from "@/lib/services/context"

/**
 * Serving a repeat question from the last answer instead of re-running the loop.
 *
 * Backed by `ai_search_answer_cache` (migration
 * `20260808135139_ai_answer_cache_and_standing_questions.sql`, applied
 * 2026-08-08). Every path still degrades to a miss if the table is missing, so
 * a fresh environment that has not run migrations answers live rather than
 * erroring.
 *
 * The design constraint that shapes everything: a cached answer is only valid
 * for someone with the SAME clearance as the person it was computed for. The key
 * carries a permission fingerprint, so a controller and a superintendent asking
 * the identical question have different keys and never see each other's answer.
 * The table is service-role only for the same reason.
 *
 * Reads and writes are best-effort throughout. A cache that fails must produce a
 * slower answer, never no answer.
 */

const CACHE_TABLE = "ai_search_answer_cache"

/**
 * Tables consulted for the freshness fingerprint.
 *
 * Deliberately the ones assistant answers are actually about. Widening this to
 * every table would mean an unrelated write invalidated everything, which is a
 * cache that never hits; narrowing it further would mean serving answers about
 * data that has moved.
 */
const VERSIONED_TABLES = [
  "invoices",
  "vendor_bills",
  "projects",
  "change_orders",
  "commitments",
  "rfis",
  "tasks",
] as const

function isMissingTableError(error: unknown): boolean {
  const code = typeof error === "object" && error ? (error as { code?: string }).code : undefined
  return code === "42P01"
}

/**
 * A fingerprint of how current the org's data is.
 *
 * One `max(updated_at)` per table, in parallel. Any write to a dependency moves
 * the fingerprint and every entry built on it stops being served.
 */
async function currentDataVersion(orgId: string): Promise<string> {
  const supabase = createServiceSupabaseClient()

  const stamps = await Promise.all(
    VERSIONED_TABLES.map(async (table) => {
      const { data, error } = await supabase
        .from(table)
        .select("updated_at")
        .eq("org_id", orgId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) return { entityType: table, updatedAt: null }
      return { entityType: table, updatedAt: (data?.updated_at as string | null) ?? null }
    }),
  )

  return buildDataVersion(stamps)
}

export interface AnswerCacheLookup {
  /** The stored answer, when one is fresh. */
  hit: AskAiSearchResponse | null
  /** Everything needed to store the answer if this was a miss. */
  write: {
    cacheKey: string
    dataVersion: string
    permissionFingerprint: string
  } | null
}

/**
 * Look for a usable answer, and prepare the write for when there isn't one.
 *
 * Returns `{hit: null, write: null}` for anything that must not be cached at
 * all — a mutation request, a question about "right now", or an org whose data
 * version could not be established. A missing version is treated as a hard
 * refusal rather than a soft one: serving an answer we cannot prove is current
 * is the failure this whole module exists to avoid.
 */
export async function lookupCachedAnswer(input: {
  context: OrgServiceContext
  question: string
  projectId?: string | null
  assistantMode: "org" | "general"
}): Promise<AnswerCacheLookup> {
  const { context, question, assistantMode } = input
  if (!isCacheableQuestion(question)) return { hit: null, write: null }

  try {
    const permissions = await getUserPermissions(context.userId, context.orgId)
    const dataVersion = await currentDataVersion(context.orgId)
    if (dataVersion === "unknown") return { hit: null, write: null }

    const cacheKey = buildAnswerCacheKey({
      question,
      projectId: input.projectId ?? null,
      assistantMode,
      permissions,
    })
    const write = {
      cacheKey,
      dataVersion,
      permissionFingerprint: permissionFingerprint(permissions),
    }

    const supabase = createServiceSupabaseClient()
    const { data, error } = await supabase
      .from(CACHE_TABLE)
      .select("answer, data_version, expires_at, hit_count")
      .eq("org_id", context.orgId)
      .eq("cache_key", cacheKey)
      .maybeSingle()

    if (error || !data) return { hit: null, write }

    const fresh = isCacheEntryFresh(
      { dataVersion: data.data_version as string, expiresAt: data.expires_at as string },
      dataVersion,
      new Date(),
    )
    if (!fresh) return { hit: null, write }

    // Fire-and-forget: a hit counter is telemetry, and waiting on it would make
    // the cache slower than the thing it is meant to speed up.
    void supabase
      .from(CACHE_TABLE)
      .update({ hit_count: ((data.hit_count as number | null) ?? 0) + 1 })
      .eq("org_id", context.orgId)
      .eq("cache_key", cacheKey)

    return { hit: data.answer as AskAiSearchResponse, write: null }
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.warn("[answer-cache] Lookup failed; answering live", error)
    }
    return { hit: null, write: null }
  }
}

/**
 * Store an answer for the next person who asks the same thing.
 *
 * Refuses anything worth not repeating: a fallback answer, an answer that
 * reported missing data, an answer that drafted an action, or one whose figures
 * did not all come from a query. Caching a bad answer multiplies it.
 */
export async function storeCachedAnswer(input: {
  context: OrgServiceContext
  question: string
  projectId?: string | null
  assistantMode: "org" | "general"
  response: AskAiSearchResponse
  write: NonNullable<AnswerCacheLookup["write"]>
  ttlSeconds?: number
}): Promise<void> {
  const { response } = input
  if (response.mode !== "llm") return
  if ((response.missingData?.length ?? 0) > 0) return
  if ((response.actions?.length ?? 0) > 0) return
  if ((response.diagnostics?.unsupportedFigures ?? 0) > 0) return
  if ((response.diagnostics?.blockedTypes?.length ?? 0) > 0) return

  const ttl = input.ttlSeconds ?? DEFAULT_CACHE_TTL_SECONDS
  try {
    await createServiceSupabaseClient()
      .from(CACHE_TABLE)
      .upsert(
        {
          org_id: input.context.orgId,
          cache_key: input.write.cacheKey,
          question: input.question.slice(0, 1200),
          project_id: input.projectId ?? null,
          assistant_mode: input.assistantMode,
          permission_fingerprint: input.write.permissionFingerprint,
          data_version: input.write.dataVersion,
          answer: response,
          hit_count: 0,
          expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        },
        { onConflict: "org_id,cache_key" },
      )
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.warn("[answer-cache] Store failed", error)
    }
  }
}
