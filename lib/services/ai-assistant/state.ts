import "server-only"

import type {
  AiSearchArtifact,
  AiSearchCitation,
  AiSearchExportLink,
  AiSearchRelatedResult,
} from "@/lib/services/ai-search/types"
import type { AiSearchAction } from "@/lib/services/ai-search/actions"
import type { SupportedFigure } from "@/lib/ai/numeric-audit"
import type { SearchResult } from "@/lib/services/search"

export interface AssistantToolState {
  relatedResults: SearchResult[]
  artifact?: AiSearchArtifact
  exports?: AiSearchExportLink[]
  actions: AiSearchAction[]
  missingData: string[]
  toolSummaries: string[]
  toolRunCount: number
  /**
   * Every number a tool actually computed, in whole currency units. The final
   * answer is audited against this, so a figure the model worked out in its head
   * can be told apart from one that came out of the database.
   */
  figures: SupportedFigure[]
  /**
   * Entity types a tool could not read for this asker. Collected so the answer
   * discloses a narrowed view rather than presenting it as the whole picture.
   */
  blockedTypes: Set<string>
}

export function createAssistantToolState(): AssistantToolState {
  return {
    relatedResults: [],
    actions: [],
    missingData: [],
    toolSummaries: [],
    toolRunCount: 0,
    figures: [],
    blockedTypes: new Set(),
  }
}

/** Record entity types a tool was not allowed to read on this asker's behalf. */
export function recordBlockedTypes(state: AssistantToolState, types: string[]) {
  for (const type of types) state.blockedTypes.add(type)
}

/**
 * Declare a number a tool computed.
 *
 * Call this for anything a user could reasonably see quoted back at them — a
 * metric total, a row count, an aging bucket. A figure that is not declared is
 * a figure the answer cannot cite, which shows up as an unverified-number
 * caveat rather than as silence.
 */
export function recordFigure(state: AssistantToolState, label: string, value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return
  state.figures.push({ label, value })
}

export function addRelatedResults(state: AssistantToolState, results: SearchResult[]) {
  const seen = new Set(state.relatedResults.map((result) => `${result.type}:${result.id}`))
  for (const result of results) {
    const key = `${result.type}:${result.id}`
    if (seen.has(key)) continue
    seen.add(key)
    state.relatedResults.push(result)
  }
}

export function addMissingData(state: AssistantToolState, messages: string[]) {
  const seen = new Set(state.missingData)
  for (const message of messages) {
    const trimmed = message.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    state.missingData.push(trimmed)
  }
}

export function setArtifact(
  state: AssistantToolState,
  artifactData: { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] },
) {
  if (!artifactData.artifact) return
  state.artifact = artifactData.artifact
  state.exports = artifactData.exports
}

export function addAction(state: AssistantToolState, action: AiSearchAction) {
  if (state.actions.some((item) => item.id === action.id)) return
  state.actions.push(action)
}

export function recordToolSummary(state: AssistantToolState, toolName: string, summary: string) {
  state.toolRunCount += 1
  state.toolSummaries.push(`${toolName}: ${summary}`)
}

export function resultRef(result: SearchResult) {
  return `${result.type}:${result.id}`
}

export function mapRelatedResult(result: SearchResult): AiSearchRelatedResult {
  return {
    id: result.id,
    type: result.type,
    title: result.title,
    href: result.href,
    subtitle: result.subtitle,
    description: result.description,
    projectName: result.project_name,
    updatedAt: result.updated_at,
  }
}

export function mapCitation(result: SearchResult, index: number): AiSearchCitation {
  return {
    sourceId: `S${index + 1}`,
    id: result.id,
    type: result.type,
    title: result.title,
    href: result.href,
    subtitle: result.subtitle,
    projectName: result.project_name,
    updatedAt: result.updated_at,
  }
}

export function buildToolContext(state: AssistantToolState) {
  if (state.toolSummaries.length === 0) return ""
  return [
    "Deterministic tool observations:",
    ...state.toolSummaries.slice(-12).map((summary) => `- ${summary}`),
  ].join("\n")
}
