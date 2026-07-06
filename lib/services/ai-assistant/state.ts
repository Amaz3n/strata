import "server-only"

import type {
  AiSearchArtifact,
  AiSearchCitation,
  AiSearchExportLink,
  AiSearchRelatedResult,
} from "@/lib/services/ai-search"
import type { AiSearchAction } from "@/lib/services/ai-search/actions"
import type { SearchResult } from "@/lib/services/search"

export interface AssistantToolState {
  relatedResults: SearchResult[]
  artifact?: AiSearchArtifact
  exports?: AiSearchExportLink[]
  actions: AiSearchAction[]
  missingData: string[]
  toolSummaries: string[]
  toolRunCount: number
}

export function createAssistantToolState(): AssistantToolState {
  return {
    relatedResults: [],
    actions: [],
    missingData: [],
    toolSummaries: [],
    toolRunCount: 0,
  }
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
