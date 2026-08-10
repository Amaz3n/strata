import { NextRequest, NextResponse } from "next/server"

import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { logger } from "@/lib/logging/logger"
import { DEFAULT_EVAL_CASES, runAiAssistantEvals } from "@/lib/services/ai-assistant/evals"
import type { EvalCase } from "@/lib/ai/eval-scoring"

export const runtime = "nodejs"
// Twelve cases through the real tool loop, sequentially.
export const maxDuration = 300

/**
 * Run the assistant eval suite against the CALLER'S org.
 *
 * Not in `PUBLIC_API_ROUTES`: this must sit behind the normal auth proxy, and it
 * is permission-gated on top of that. It spends real tokens and answers real
 * questions about real records, so it belongs in the QA org — Arc has no staging
 * environment, and pointing it at a customer org would put their data through a
 * dozen model calls for a test run.
 *
 * POST so it is never triggered by a link, a prefetch, or a crawler.
 */

function parseCases(input: unknown): EvalCase[] | null {
  if (!Array.isArray(input)) return null

  const cases: EvalCase[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const value = item as Record<string, unknown>
    if (typeof value.id !== "string" || typeof value.question !== "string") continue

    const stringArray = (raw: unknown) =>
      Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : undefined

    cases.push({
      id: value.id,
      question: value.question,
      scope: value.scope === "project" ? "project" : "org",
      expectKeywords: stringArray(value.expectKeywords),
      forbidKeywords: stringArray(value.forbidKeywords),
      requiresGrounding: value.requiresGrounding === true,
      expectRefusal: value.expectRefusal === true,
    })
  }

  return cases.length > 0 ? cases : null
}

export async function POST(request: NextRequest) {
  await requireAnyPermissionGuard(["org.admin", "platform.support.read"])

  let cases: EvalCase[] = DEFAULT_EVAL_CASES
  try {
    const body = await request.json()
    cases = parseCases((body as { cases?: unknown })?.cases) ?? DEFAULT_EVAL_CASES
  } catch {
    // No body, or an unparseable one: run the standing suite.
  }

  try {
    const report = await runAiAssistantEvals(cases)
    return NextResponse.json({
      summary: report.summary,
      errored: report.errored,
      totalLatencyMs: report.totalLatencyMs,
      // The full response bodies are deliberately left out: they can be long,
      // and what a failing run needs is which check failed and on what.
      runs: report.runs.map((run) => ({
        id: run.case.id,
        question: run.case.question,
        latencyMs: run.latencyMs,
        error: run.error,
        passed: run.result?.passed ?? false,
        score: run.result?.score ?? 0,
        failedChecks:
          run.result?.checks.filter((check) => !check.passed).map((check) => ({
            name: check.name,
            detail: check.detail,
          })) ?? [],
      })),
    })
  } catch (error) {
    logger.error("AI assistant eval run failed", { error })
    return NextResponse.json({ error: "Eval run failed" }, { status: 500 })
  }
}
