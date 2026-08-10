import type { AiProvider } from "@/lib/services/ai-config"
import type { AiSearchAction } from "@/lib/services/ai-search/actions"
import type { SearchEntityType } from "@/lib/services/search"

/**
 * The AI search response contract.
 *
 * These types are the boundary between the assistant and everything that
 * renders its output, so they live apart from any one implementation of the
 * assistant. They were previously declared inside the legacy pipeline module,
 * which meant the live tool-loop harness had to import 1,900 lines of dormant
 * planner code to name its own response shape.
 */

export interface AiSearchCitation {
  sourceId: string
  id: string
  type: SearchEntityType
  title: string
  href: string
  subtitle?: string
  projectName?: string
  updatedAt?: string
}

export interface AiSearchRelatedResult {
  id: string
  type: SearchEntityType
  title: string
  href: string
  subtitle?: string
  description?: string
  projectName?: string
  updatedAt?: string
}

export type AiArtifactValue = string | number | null

export type AiChartType = "bar" | "horizontalBar" | "line" | "area" | "pie" | "donut" | "stackedBar"

export const AI_CHART_TYPES: AiChartType[] = ["bar", "horizontalBar", "line", "area", "pie", "donut", "stackedBar"]

export interface AiChartPoint {
  label: string
  value: number
}

// One measured dimension in a multi-series chart (stacked bar / multi-line).
export interface AiChartSeries {
  key: string
  label: string
}

// A single headline metric shown in the full-bleed report surface.
export interface AiArtifactKpi {
  label: string
  value: string
  tone?: "neutral" | "danger" | "warning" | "success"
}

// A collapsible detail section rendered under the chart (e.g. one AR aging
// bucket and the invoices that fall in it). Collapsed by default in the UI.
export interface AiArtifactGroup {
  label: string
  total?: string
  count?: number
  columns: string[]
  rows: AiArtifactValue[][]
}

export interface AiSearchArtifact {
  kind: "table" | "chart" | "report"
  datasetId: string
  title: string
  // Distinguishes canonical reports (e.g. AR aging) from generic analytics so
  // the surface can apply report-specific affordances.
  reportType?: "ar_aging" | "analytics"
  summary?: string
  kpis?: AiArtifactKpi[]
  groups?: AiArtifactGroup[]
  table?: {
    columns: string[]
    rows: AiArtifactValue[][]
  }
  chart?: {
    type: AiChartType
    // Single-series charts populate `points`. Multi-series charts (stackedBar,
    // multi-line) populate `series` + `data` instead, where each data row is
    // keyed by `label` plus one numeric value per series key.
    points: AiChartPoint[]
    series?: AiChartSeries[]
    data?: Array<Record<string, AiArtifactValue>>
    valuePrefix?: string
    valueSuffix?: string
  }
}

export interface AiSearchExportLink {
  format: "csv" | "pdf"
  href: string
  label: string
}

export interface AiSearchTraceEvent {
  id: string
  status: "started" | "running" | "completed" | "warning"
  label: string
  detail?: string
  thought?: string
  timestamp: string
}

export interface AskAiSearchResponse {
  answer: string
  citations: AiSearchCitation[]
  relatedResults: AiSearchRelatedResult[]
  generatedAt: string
  assistantMode: "org" | "general"
  mode: "llm" | "fallback"
  provider?: AiProvider
  model?: string
  configSource?: "org" | "platform" | "env" | "default"
  confidence?: "low" | "medium" | "high"
  missingData?: string[]
  artifact?: AiSearchArtifact
  exports?: AiSearchExportLink[]
  actions?: AiSearchAction[]
  sessionId?: string
  /**
   * Machine-readable diagnostics about how the answer was constrained.
   *
   * The same facts appear in `missingData` as sentences for the user; these are
   * the countable form, so evals and the AI console can track them over time
   * without parsing prose.
   */
  diagnostics?: {
    /** Figures the answer stated that no tool produced. */
    unsupportedFigures: number
    /** Entity types the asker's role could not read. */
    blockedTypes: string[]
  }
}

export type AiSearchArtifactDataset = {
  id: string
  orgId: string
  title: string
  columns: string[]
  rows: AiArtifactValue[][]
  createdAt: string
}
