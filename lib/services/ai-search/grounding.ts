import "server-only"

import type { LlmAnswer } from "@/lib/services/ai-search/llm"
import type { SearchResult } from "@/lib/services/search"

type RetrievedSource = {
  sourceId: string
  result: SearchResult
}

type GroundedAnswerVerification = {
  answer: string
  citationIds: string[]
  downgradedToFallback: boolean
  confidence: "low" | "medium" | "high"
  missingData: string[]
  notes: string[]
}

const MAX_CITATIONS = 5

export function verifyGroundedAnswer({
  llmAnswer,
  sources,
  fallbackAnswer,
  rowCount,
  baseConfidence,
  missingData,
}: {
  llmAnswer: LlmAnswer | null
  sources: RetrievedSource[]
  fallbackAnswer: string
  rowCount: number
  baseConfidence: "low" | "medium" | "high"
  missingData?: string[]
}): GroundedAnswerVerification {
  const nextMissingData = [...(missingData ?? [])]
  const defaultCitationIds = sources.slice(0, Math.min(2, MAX_CITATIONS)).map((source) => source.sourceId)

  if (!llmAnswer) {
    if (sources.length > 0 && defaultCitationIds.length === 0) {
      nextMissingData.push("No usable citations were generated from grounded sources.")
    }
    return {
      answer: fallbackAnswer,
      citationIds: defaultCitationIds,
      downgradedToFallback: true,
      confidence: "low",
      missingData: Array.from(new Set(nextMissingData)),
      notes: ["No model answer was available, so deterministic fallback was used."],
    }
  }

  const rawAnswer = llmAnswer.answer.trim()
  const hasNumericClaims = /\$?\d[\d,.]*/.test(rawAnswer)
  const citationIds = llmAnswer.citationIds.filter((id) => sources.some((source) => source.sourceId === id))
  const notes: string[] = []
  let downgraded = false
  let answer = rawAnswer
  let confidence = baseConfidence

  if (sources.length > 0 && citationIds.length === 0) {
    notes.push("Model answer omitted citations.")
    if (defaultCitationIds.length > 0) {
      citationIds.push(...defaultCitationIds)
      if (!nextMissingData.includes("Citations were auto-recovered from top grounded records.")) {
        nextMissingData.push("Citations were auto-recovered from top grounded records.")
      }
    }
  }

  if (rowCount === 0 && hasNumericClaims) {
    downgraded = true
    notes.push("Numeric claims were rejected because no grounded rows were returned.")
    if (!nextMissingData.includes("No grounded rows supported numeric claims.")) {
      nextMissingData.push("No grounded rows supported numeric claims.")
    }
  }

  if (answer.length < 16 && rowCount > 0) {
    downgraded = true
    notes.push("Model answer was too short for grounded synthesis.")
  }

  if (downgraded) {
    answer = fallbackAnswer
    confidence = "low"
  }

  return {
    answer,
    citationIds: citationIds.length > 0 ? citationIds : defaultCitationIds,
    downgradedToFallback: downgraded,
    confidence,
    missingData: Array.from(new Set(nextMissingData)),
    notes,
  }
}

export function resolveCitations(sources: RetrievedSource[], citationIds: string[]) {
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]))
  const uniqueIds: string[] = []

  for (const id of citationIds) {
    if (!sourceById.has(id)) continue
    if (uniqueIds.includes(id)) continue
    uniqueIds.push(id)
  }

  const fallbackIds = uniqueIds.length > 0 ? uniqueIds : sources.map((source) => source.sourceId).slice(0, MAX_CITATIONS)
  return fallbackIds
    .slice(0, MAX_CITATIONS)
    .map((sourceId) => sourceById.get(sourceId))
    .filter((source): source is RetrievedSource => Boolean(source))
}

export function inferConfidenceFromResponse({
  rowCount,
  citationsCount,
  fallback = "low",
}: {
  rowCount: number
  citationsCount: number
  fallback?: "low" | "medium" | "high"
}) {
  if (rowCount >= 10 && citationsCount >= 2) return "high" as const
  if (rowCount > 0 || citationsCount > 0) return "medium" as const
  return fallback
}
