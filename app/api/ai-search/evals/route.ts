import { NextRequest, NextResponse } from "next/server"

import { askAiSearch } from "@/lib/services/ai-search"
import { getAiSearchRuntimeFlags } from "@/lib/services/ai-search-flags"
import { runAiSearchEvalHarness, type AiSearchEvalCase } from "@/lib/services/ai-search/evals"
import { requireOrgContext } from "@/lib/services/context"

export const runtime = "nodejs"

function parseGate(input: unknown) {
  if (!input || typeof input !== "object") return undefined
  const value = input as Record<string, unknown>
  return {
    minPassRate: typeof value.minPassRate === "number" ? value.minPassRate : undefined,
    minCitationCoverageRate:
      typeof value.minCitationCoverageRate === "number" ? value.minCitationCoverageRate : undefined,
    minAvgRelatedResults: typeof value.minAvgRelatedResults === "number" ? value.minAvgRelatedResults : undefined,
    maxFailedCases: typeof value.maxFailedCases === "number" ? value.maxFailedCases : undefined,
  }
}

function parseCases(input: unknown): AiSearchEvalCase[] | undefined {
  if (!Array.isArray(input)) return undefined

  const normalized: AiSearchEvalCase[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    const value = item as Record<string, unknown>
    if (typeof value.id !== "string" || typeof value.category !== "string" || typeof value.query !== "string") {
      continue
    }

    const category =
      value.category === "lookup" ||
      value.category === "aggregate" ||
      value.category === "cross_domain" ||
      value.category === "diagnostic" ||
      value.category === "follow_up"
        ? value.category
        : null
    if (!category) continue

    normalized.push({
      id: value.id.trim(),
      category,
      query: value.query.trim(),
      mustIncludeAny: Array.isArray(value.mustIncludeAny)
        ? value.mustIncludeAny.filter((keyword): keyword is string => typeof keyword === "string" && keyword.trim().length > 0)
        : undefined,
      minCitations:
        typeof value.minCitations === "number" && Number.isFinite(value.minCitations) ? value.minCitations : undefined,
      minRelatedResults:
        typeof value.minRelatedResults === "number" && Number.isFinite(value.minRelatedResults) ? value.minRelatedResults : undefined,
    })
  }

  return normalized.length > 0 ? normalized : undefined
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireOrgContext()
    const flags = await getAiSearchRuntimeFlags(context)
    if (!flags.evalHarness) {
      return NextResponse.json({ error: "AI eval harness is disabled for this org." }, { status: 403 })
    }

    const body = (await request.json().catch(() => ({}))) as {
      cases?: unknown
      mode?: unknown
      gate?: unknown
      requirePass?: unknown
    }
    const mode = body.mode === "general" ? "general" : "org"
    const cases = parseCases(body.cases)
    const gate = parseGate(body.gate)
    const requirePass = body.requirePass === true

    const run = await runAiSearchEvalHarness({
      cases,
      execute: (query) => askAiSearch(query, { mode, limit: 20 }),
      gate,
    })

    if (requirePass && run.gate && !run.gate.passed) {
      return NextResponse.json(
        {
          mode,
          ranAt: new Date().toISOString(),
          summary: run.summary,
          gate: run.gate,
          results: run.results.map((item) => ({
            ...item,
            answer: item.answer.slice(0, 4000),
          })),
        },
        { status: 412 },
      )
    }

    return NextResponse.json({
      mode,
      ranAt: new Date().toISOString(),
      summary: run.summary,
      gate: run.gate,
      results: run.results.map((item) => ({
        ...item,
        answer: item.answer.slice(0, 4000),
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run AI search eval harness."
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
