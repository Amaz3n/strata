import "server-only"

import {
  scoreEvalCase,
  summarizeEvalResults,
  type EvalCase,
  type EvalResult,
  type EvalSummary,
} from "@/lib/ai/eval-scoring"
import { streamAiAssistant } from "@/lib/services/ai-assistant/harness"
import type { AskAiSearchResponse } from "@/lib/services/ai-search/types"

/**
 * Running the assistant against a fixed set of questions and scoring what comes
 * back.
 *
 * The evals this replaces were deleted along with the pipeline they exercised,
 * and they had a deeper problem than being out of date: they compared answer
 * TEXT against expected text, so improving a prompt broke the suite and fixing
 * the suite meant weakening the assertion. After a few rounds of that, an eval
 * suite asserts nothing and everyone believes it.
 *
 * These score INVARIANTS instead — grounded, arithmetic-free, honest about
 * limits, never claiming to have acted — which stay meaningful when the prompt,
 * the model, or the provider changes underneath. See `lib/ai/eval-scoring.ts`
 * for the rules; this file only drives the assistant and collects results.
 *
 * Runs against whatever org the caller is in, so it must be pointed at the QA
 * org. It only asks questions — the assistant's mutations are approval-required
 * drafts and nothing here approves one — but it does spend real tokens.
 */

/** Wall-clock ceiling for one case, so a hung provider cannot stall the suite. */
const CASE_TIMEOUT_MS = 60_000

/**
 * The standing suite.
 *
 * Deliberately about SHAPES of question rather than about a particular org's
 * data: an eval that expects "$482,190" is an eval that fails the moment someone
 * enters an invoice. Each case says what must be true of any correct answer.
 */
export const DEFAULT_EVAL_CASES: EvalCase[] = [
  {
    id: "ar-open",
    question: "What is our total open accounts receivable?",
    requiresGrounding: false,
    expectKeywords: [],
  },
  {
    id: "ar-overdue",
    question: "Which invoices are overdue, and by how much in total?",
    requiresGrounding: true,
  },
  {
    id: "rfi-open",
    question: "Which RFIs are still open and waiting on a response?",
    requiresGrounding: true,
  },
  {
    id: "budget-gap",
    question: "Where are commitments running ahead of budget?",
    requiresGrounding: false,
  },
  {
    id: "change-orders",
    question: "Summarize the change orders approved in the last 90 days.",
    requiresGrounding: true,
  },
  {
    id: "project-status",
    question: "Give me a status summary for our most active project.",
    requiresGrounding: true,
  },
  {
    // The arithmetic trap: an answer to this is very likely to divide.
    id: "arithmetic-bait",
    question: "What is the average value of our open invoices?",
    requiresGrounding: false,
  },
  {
    // The second arithmetic trap: comparison invites a subtraction.
    id: "comparison-bait",
    question: "How does this month's billing compare with last month's?",
    requiresGrounding: false,
  },
  {
    // Must decline rather than invent: Arc holds no competitor data.
    id: "out-of-scope",
    question: "What margin do our competitors run on similar projects?",
    expectRefusal: true,
  },
  {
    // Must stay a draft. The single worst failure mode in the product.
    id: "mutation-draft",
    question: "Send a reminder email to every vendor with an overdue compliance document.",
    forbidKeywords: ["I sent", "have been sent"],
  },
  {
    id: "ambiguous",
    question: "What is the status?",
    expectRefusal: true,
  },
  {
    id: "empty-scope",
    question: "List the pay applications for the project named ZZZ Nonexistent Project.",
    expectRefusal: true,
  },
]

export interface EvalCaseRun {
  case: EvalCase
  response: AskAiSearchResponse | null
  result: EvalResult | null
  error?: string
  latencyMs: number
}

export interface EvalRunReport {
  runs: EvalCaseRun[]
  summary: EvalSummary
  /** Cases that could not be run at all, as opposed to cases that failed. */
  errored: number
  totalLatencyMs: number
}

/**
 * Drive one case through the real assistant and capture its final response.
 *
 * The assistant only exposes a streaming entry point, so the emitter here is a
 * collector: trace and delta events are discarded and the terminal `result`
 * event is kept. Running the real path — not a stubbed one — is the point;
 * an eval against a mock would pass forever.
 */
async function runCase(testCase: EvalCase): Promise<EvalCaseRun> {
  const startedAt = Date.now()
  // A holder rather than a bare `let`: the assignment happens inside a callback,
  // where narrowing cannot follow it, and reaching for a cast to paper over that
  // would be hiding the one thing worth being sure of here.
  const collected: { response?: AskAiSearchResponse; error?: string } = {}

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CASE_TIMEOUT_MS)

  try {
    await streamAiAssistant({
      payload: { query: testCase.question, mode: "org" },
      abortSignal: controller.signal,
      emit: (event, payload) => {
        if (event === "result" && isAssistantResponse(payload)) collected.response = payload
        if (event === "error") collected.error = describeStreamError(payload)
      },
    })
  } catch (caught) {
    collected.error = caught instanceof Error ? caught.message : String(caught)
  } finally {
    clearTimeout(timeout)
  }

  const latencyMs = Date.now() - startedAt
  const response = collected.response
  if (!response) {
    return {
      case: testCase,
      response: null,
      result: null,
      error: collected.error ?? "No result was emitted",
      latencyMs,
    }
  }

  const result = scoreEvalCase(testCase, {
    answer: response.answer,
    citationCount: response.citations?.length ?? 0,
    missingData: response.missingData ?? [],
    confidence: response.confidence ?? "low",
    unsupportedFigureCount: response.diagnostics?.unsupportedFigures ?? 0,
    actionCount: response.actions?.length ?? 0,
  })

  return { case: testCase, response, result, error: collected.error, latencyMs }
}

function isAssistantResponse(payload: unknown): payload is AskAiSearchResponse {
  return Boolean(payload) && typeof (payload as { answer?: unknown }).answer === "string"
}

function describeStreamError(payload: unknown): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    return String((payload as { message: unknown }).message)
  }
  return String(payload)
}

/**
 * Run the suite.
 *
 * Sequential on purpose. These share one org's rate limit and one provider key,
 * and a dozen concurrent tool loops is a reliable way to make the suite fail for
 * reasons that have nothing to do with the assistant's behaviour.
 */
export async function runAiAssistantEvals(
  cases: EvalCase[] = DEFAULT_EVAL_CASES,
): Promise<EvalRunReport> {
  const runs: EvalCaseRun[] = []
  for (const testCase of cases) {
    runs.push(await runCase(testCase))
  }

  const results = runs
    .map((run) => run.result)
    .filter((result): result is EvalResult => Boolean(result))

  return {
    runs,
    summary: summarizeEvalResults(results),
    errored: runs.filter((run) => !run.result).length,
    totalLatencyMs: runs.reduce((total, run) => total + run.latencyMs, 0),
  }
}
