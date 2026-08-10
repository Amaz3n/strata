import "server-only"

import { createHash } from "node:crypto"

import { runWithServiceOrgContext } from "@/lib/services/context"
import { streamAiAssistant } from "@/lib/services/ai-assistant/harness"
import type { AskAiSearchResponse } from "@/lib/services/ai-search/types"
import { recordEvent } from "@/lib/services/events"
import { normalizeProductTier } from "@/lib/product-tier"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Standing questions: the assistant asking on your behalf, before you think to.
 *
 * Backed by `ai_standing_questions` (migration
 * `20260808135139_ai_answer_cache_and_standing_questions.sql`, applied
 * 2026-08-08). With the table absent the sweep still finds nothing and returns
 * cleanly, so a fresh environment does not fail its cron.
 *
 * The whole value is in the DELTA. "Which commitments are running over budget"
 * answered identically every morning for three weeks is an email people filter;
 * the same question the morning the answer CHANGES is the reason to have built
 * it. So each run digests its answer, compares it to the last, and only records
 * an event when it moved.
 *
 * Two things this deliberately does not do:
 *
 * - It does not run unrestricted. Each question carries `run_as_user_id` and is
 *   answered under that person's permissions, so a standing question can never
 *   surface something its owner could not have asked for themselves.
 * - It does not act. The assistant's mutations are approval-required drafts and
 *   a cron run approves nothing; a changed answer produces an event, and a human
 *   decides what it means.
 */

/** Questions answered per sweep. The cron runs often enough to drain a backlog. */
const BATCH_SIZE = 10

/** Wall-clock ceiling per question. */
const QUESTION_TIMEOUT_MS = 60_000

const CADENCE_MINUTES: Record<string, number> = {
  hourly: 60,
  daily: 60 * 24,
  weekly: 60 * 24 * 7,
}

interface StandingQuestionRow {
  id: string
  org_id: string
  project_id: string | null
  label: string
  question: string
  cadence: string
  run_as_user_id: string | null
  last_run_at: string | null
  last_answer_digest: string | null
}

export interface StandingQuestionSweepResult {
  considered: number
  answered: number
  changed: number
  failed: number
}

function isMissingTableError(error: unknown): boolean {
  const code = typeof error === "object" && error ? (error as { code?: string }).code : undefined
  return code === "42P01"
}

/**
 * A digest of what the answer SAYS, not of the whole response object.
 *
 * Timestamps, session ids and citation ordering all move between runs without
 * the answer having changed, and digesting those would report a change every
 * single time — which is the same as reporting none.
 */
function answerDigest(response: AskAiSearchResponse): string {
  const basis = [
    response.answer.trim(),
    ...(response.citations ?? []).map((citation) => `${citation.type}:${citation.id}`).sort(),
  ].join("|")
  return createHash("sha256").update(basis).digest("hex").slice(0, 32)
}

function isDue(row: StandingQuestionRow, now: Date): boolean {
  if (!row.last_run_at) return true
  const interval = CADENCE_MINUTES[row.cadence] ?? CADENCE_MINUTES.daily
  return now.getTime() - Date.parse(row.last_run_at) >= interval * 60_000
}

/**
 * Build the context this question runs under.
 *
 * Membership is re-validated on EVERY run, not trusted from when the question
 * was created. Someone who has left the org must not keep generating answers
 * about it from a row nobody remembers exists.
 */
async function contextForQuestion(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  row: StandingQuestionRow,
) {
  const userId = row.run_as_user_id
  if (!userId) throw new Error("This standing question has no owner to run as")

  const [{ data: membership }, { data: org }] = await Promise.all([
    supabase
      .from("memberships")
      .select("id")
      .eq("org_id", row.org_id)
      .eq("user_id", userId)
      .eq("status", "active")
      .maybeSingle(),
    supabase.from("orgs").select("product_tier").eq("id", row.org_id).maybeSingle(),
  ])

  if (!membership) throw new Error("The owner is no longer an active organization member")
  if (!org) throw new Error("Organization not found")

  return {
    supabase,
    orgId: row.org_id,
    userId,
    productTier: normalizeProductTier(org.product_tier),
  }
}

async function answerQuestion(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  row: StandingQuestionRow,
): Promise<AskAiSearchResponse | null> {
  const collected: { response?: AskAiSearchResponse } = {}
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), QUESTION_TIMEOUT_MS)
  const context = await contextForQuestion(supabase, row)

  try {
    // Answered AS the owning user: the assistant's own permission checks then
    // apply exactly as they would if that person had typed the question.
    await runWithServiceOrgContext(context, async () => {
      await streamAiAssistant({
        payload: {
          query: row.question,
          mode: "org",
          currentProjectId: row.project_id,
        },
        abortSignal: controller.signal,
        emit: (event, payload) => {
          if (event === "result" && isAssistantResponse(payload)) {
            collected.response = payload
          }
        },
      })
    })
  } finally {
    clearTimeout(timeout)
  }

  return collected.response ?? null
}

function isAssistantResponse(payload: unknown): payload is AskAiSearchResponse {
  return Boolean(payload) && typeof (payload as { answer?: unknown }).answer === "string"
}

/**
 * Answer every standing question that is due.
 *
 * A question that fails records its error and its run time, so a permanently
 * broken question does not monopolise every sweep by staying perpetually due.
 */
export async function sweepStandingQuestions(): Promise<StandingQuestionSweepResult> {
  const result: StandingQuestionSweepResult = { considered: 0, answered: 0, changed: 0, failed: 0 }
  const supabase = createServiceSupabaseClient()
  const now = new Date()

  const { data, error } = await supabase
    .from("ai_standing_questions")
    .select(
      "id, org_id, project_id, label, question, cadence, run_as_user_id, last_run_at, last_answer_digest",
    )
    .eq("enabled", true)
    .order("last_run_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE * 3)

  if (error) {
    if (isMissingTableError(error)) return result
    throw new Error(`Failed to load standing questions: ${error.message}`)
  }

  const due = ((data ?? []) as StandingQuestionRow[])
    .filter((row) => row.run_as_user_id && isDue(row, now))
    .slice(0, BATCH_SIZE)
  result.considered = due.length

  for (const row of due) {
    const runAt = new Date().toISOString()
    try {
      const response = await answerQuestion(supabase, row)
      if (!response) {
        result.failed += 1
        await supabase
          .from("ai_standing_questions")
          .update({ last_run_at: runAt, last_error: "The assistant returned no answer." })
          .eq("id", row.id)
        continue
      }

      const digest = answerDigest(response)
      const changed = digest !== row.last_answer_digest
      result.answered += 1

      await supabase
        .from("ai_standing_questions")
        .update({
          last_run_at: runAt,
          last_answer: response,
          last_answer_digest: digest,
          last_error: null,
          ...(changed ? { last_changed_at: runAt } : {}),
        })
        .eq("id", row.id)

      if (!changed) continue
      result.changed += 1

      // Only a CHANGED answer is an event. A first run counts as a change —
      // there was no previous answer, so everything in it is news.
      await recordEvent({
        orgId: row.org_id,
        eventType: "ai_standing_question_changed",
        entityType: "ai_standing_question",
        entityId: row.id,
        payload: {
          label: row.label,
          question: row.question,
          project_id: row.project_id,
          answer: response.answer.slice(0, 2000),
          first_run: row.last_answer_digest === null,
        },
      })
    } catch (caught) {
      result.failed += 1
      const message = caught instanceof Error ? caught.message : String(caught)
      await supabase
        .from("ai_standing_questions")
        .update({ last_run_at: runAt, last_error: message.slice(0, 500) })
        .eq("id", row.id)
    }
  }

  return result
}
