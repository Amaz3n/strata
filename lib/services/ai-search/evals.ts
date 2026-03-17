import type { AskAiSearchResponse } from "@/lib/services/ai-search"

export type AiSearchEvalCategory = "lookup" | "aggregate" | "cross_domain" | "diagnostic" | "follow_up"

export interface AiSearchEvalCase {
  id: string
  category: AiSearchEvalCategory
  query: string
  mustIncludeAny?: string[]
  minCitations?: number
  minRelatedResults?: number
}

export interface AiSearchEvalCaseResult {
  id: string
  category: AiSearchEvalCategory
  query: string
  answer: string
  citations: number
  relatedResults: number
  pass: boolean
  issues: string[]
}

export interface AiSearchEvalSummary {
  total: number
  passed: number
  failed: number
  passRate: number
  citationCoverageRate: number
  avgRelatedResults: number
}

export interface AiSearchEvalRunResult {
  summary: AiSearchEvalSummary
  results: AiSearchEvalCaseResult[]
  gate?: {
    passed: boolean
    failures: string[]
    thresholds: AiSearchEvalGateThresholds
  }
}

export interface AiSearchEvalGateThresholds {
  minPassRate?: number
  minCitationCoverageRate?: number
  minAvgRelatedResults?: number
  maxFailedCases?: number
}

export interface RunAiSearchEvalHarnessInput {
  cases?: AiSearchEvalCase[]
  execute: (query: string) => Promise<AskAiSearchResponse>
  gate?: AiSearchEvalGateThresholds
}

export const DEFAULT_AI_SEARCH_GOLD_SET: AiSearchEvalCase[] = [
  {
    id: "lookup-rfi",
    category: "lookup",
    query: "Find RFI 042",
    minCitations: 1,
    minRelatedResults: 1,
  },
  {
    id: "aggregate-invoices-monthly",
    category: "aggregate",
    query: "Invoice totals by month for last 12 months",
    mustIncludeAny: ["month", "invoice", "total"],
    minCitations: 1,
  },
  {
    id: "cross-domain-budget-vs-commitments",
    category: "cross_domain",
    query: "Are commitments exceeding budget on active projects?",
    mustIncludeAny: ["commitment", "budget", "project"],
    minCitations: 1,
  },
  {
    id: "diagnostic-overdue",
    category: "diagnostic",
    query: "What is driving overdue work?",
    mustIncludeAny: ["overdue", "work"],
    minCitations: 1,
  },
]

function includesAnyKeyword(answer: string, keywords: string[]) {
  const normalized = answer.toLowerCase()
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))
}

function clampThreshold(value: unknown, fallback: number, min = 0, max = 1) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function normalizeGateThresholds(raw?: AiSearchEvalGateThresholds): AiSearchEvalGateThresholds {
  return {
    minPassRate: clampThreshold(raw?.minPassRate, 0.8),
    minCitationCoverageRate: clampThreshold(raw?.minCitationCoverageRate, 0.8),
    minAvgRelatedResults: clampThreshold(raw?.minAvgRelatedResults, 1, 0, 1000),
    maxFailedCases:
      typeof raw?.maxFailedCases === "number" && Number.isFinite(raw.maxFailedCases)
        ? Math.max(0, Math.floor(raw.maxFailedCases))
        : 0,
  }
}

export async function runAiSearchEvalHarness(input: RunAiSearchEvalHarnessInput): Promise<AiSearchEvalRunResult> {
  const cases = input.cases && input.cases.length > 0 ? input.cases : DEFAULT_AI_SEARCH_GOLD_SET
  const results: AiSearchEvalCaseResult[] = []

  for (const testCase of cases) {
    try {
      const response = await input.execute(testCase.query)
      const citations = response.citations.length
      const relatedResults = response.relatedResults.length
      const answer = response.answer.trim()
      const issues: string[] = []

      if (!answer) {
        issues.push("Empty answer")
      }
      if (typeof testCase.minCitations === "number" && citations < testCase.minCitations) {
        issues.push(`Expected at least ${testCase.minCitations} citations, got ${citations}`)
      }
      if (typeof testCase.minRelatedResults === "number" && relatedResults < testCase.minRelatedResults) {
        issues.push(`Expected at least ${testCase.minRelatedResults} related results, got ${relatedResults}`)
      }
      if (Array.isArray(testCase.mustIncludeAny) && testCase.mustIncludeAny.length > 0) {
        if (!includesAnyKeyword(answer, testCase.mustIncludeAny)) {
          issues.push(`Answer did not include any expected keywords: ${testCase.mustIncludeAny.join(", ")}`)
        }
      }

      results.push({
        id: testCase.id,
        category: testCase.category,
        query: testCase.query,
        answer,
        citations,
        relatedResults,
        pass: issues.length === 0,
        issues,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown eval execution error"
      results.push({
        id: testCase.id,
        category: testCase.category,
        query: testCase.query,
        answer: "",
        citations: 0,
        relatedResults: 0,
        pass: false,
        issues: [message],
      })
    }
  }

  const passed = results.filter((item) => item.pass).length
  const failed = results.length - passed
  const withCitations = results.filter((item) => item.citations > 0).length
  const relatedTotal = results.reduce((acc, item) => acc + item.relatedResults, 0)
  const summary: AiSearchEvalSummary = {
    total: results.length,
    passed,
    failed,
    passRate: results.length > 0 ? passed / results.length : 0,
    citationCoverageRate: results.length > 0 ? withCitations / results.length : 0,
    avgRelatedResults: results.length > 0 ? relatedTotal / results.length : 0,
  }

  const thresholds = normalizeGateThresholds(input.gate)
  const failures: string[] = []
  if (summary.passRate < (thresholds.minPassRate ?? 0.8)) {
    failures.push(`passRate ${summary.passRate.toFixed(2)} is below threshold ${(thresholds.minPassRate ?? 0.8).toFixed(2)}`)
  }
  if (summary.citationCoverageRate < (thresholds.minCitationCoverageRate ?? 0.8)) {
    failures.push(
      `citationCoverageRate ${summary.citationCoverageRate.toFixed(2)} is below threshold ${(thresholds.minCitationCoverageRate ?? 0.8).toFixed(2)}`,
    )
  }
  if (summary.avgRelatedResults < (thresholds.minAvgRelatedResults ?? 1)) {
    failures.push(
      `avgRelatedResults ${summary.avgRelatedResults.toFixed(2)} is below threshold ${(thresholds.minAvgRelatedResults ?? 1).toFixed(2)}`,
    )
  }
  if (summary.failed > (thresholds.maxFailedCases ?? 0)) {
    failures.push(`failed cases ${summary.failed} exceeds threshold ${thresholds.maxFailedCases ?? 0}`)
  }

  return {
    summary,
    results,
    gate: {
      passed: failures.length === 0,
      failures,
      thresholds,
    },
  }
}
