import type { ProjectPosture } from "@/lib/product-tier"

/**
 * The shape every report in the catalog speaks.
 *
 * One definition drives four surfaces — the catalog row, the on-screen view, the
 * CSV/PDF export, and the immutable run snapshot — so a report can never render
 * numbers its export disagrees with. Adding a report means adding a definition
 * to `lib/reports/registry.ts` and nothing else.
 */

export type ReportScope = "org" | "project"

export type ReportGroup = "financial" | "production" | "sales" | "compliance"

export const REPORT_GROUP_LABELS: Record<ReportGroup, string> = {
  financial: "Financial",
  production: "Production",
  sales: "Sales",
  compliance: "Compliance",
}

/** Column type drives alignment, formatting, and how the cell exports. */
export type ReportColumnType = "text" | "money" | "number" | "percent" | "date" | "status"

export type ReportTone = "positive" | "negative" | "warning" | "muted"

export interface ReportColumn {
  key: string
  header: string
  /** Defaults to "text". Numeric types right-align and get `tabular-nums`. */
  type?: ReportColumnType
  /** Carried in exports but hidden on screen — ids, raw cents behind a formatted twin. */
  exportOnly?: boolean
  /** Tailwind width/min-width class for the header cell. */
  className?: string
}

/**
 * A cell is a bare value, or a value wrapped with presentation hints. `label`
 * overrides the formatted display (status chips); `href` makes the cell a link.
 */
export type ReportCell =
  | string
  | number
  | null
  | {
      value: string | number | null
      label?: string
      href?: string
      tone?: ReportTone
    }

export interface ReportRow {
  key: string
  /**
   * Absent keys are legal and render as "—". Columns are conditional (the
   * project column only exists at org scope), so requiring every key would push
   * that conditional into every row builder.
   */
  cells: Record<string, ReportCell | undefined>
  /**
   * Structural weight. "group" is a section header spanning the table, "subtotal"
   * and "total" render heavier with a rule above. Only plain rows link.
   */
  emphasis?: "group" | "subtotal" | "total"
  /** Deep-link for the whole row — the desk-to-workbench jump. */
  href?: string
  tone?: ReportTone
}

export interface ReportTable {
  key: string
  title?: string
  description?: string
  columns: ReportColumn[]
  rows: ReportRow[]
  /** Pinned footer row, keyed by column. Columns without a total stay blank. */
  totals?: Record<string, ReportCell | undefined>
  /**
   * Set when the underlying query truncated. The viewer always renders this —
   * a silently capped report is a wrong report.
   */
  cap?: { shown: number; total: number }
  emptyMessage?: string
}

export interface ReportStat {
  key: string
  label: string
  /** Pre-formatted: stats are display-only and never re-formatted downstream. */
  value: string
  detail?: string
  tone?: ReportTone
}

export interface ReportResult {
  /** Provenance line under the title — "As of Jul 28, 2026 · 34 projects". */
  subtitle?: string
  stats?: ReportStat[]
  tables: ReportTable[]
  /** Surfaced above the body when the data itself is qualified or partial. */
  notice?: { tone: "warning" | "info"; message: string }
}

/* -------------------------------------------------------------------------- */
/* Parameters                                                                  */
/* -------------------------------------------------------------------------- */

export interface ReportParamOption {
  value: string
  label: string
}

/**
 * Report parameters are time and report-specific options only. Division and
 * community scope stay ambient (`getAmbientDeskContext`) and are never a control
 * here — community is a lens, not a per-desk select.
 */
export type ReportParamSpec =
  | { key: string; kind: "date"; label: string }
  | { key: string; kind: "period"; label: string }
  | { key: string; kind: "select"; label: string; options: ReportParamOption[] }
  | { key: string; kind: "toggle"; label: string }

export type ReportParams = Record<string, string>

export type ReportFormat = "csv" | "pdf" | "json"

/* -------------------------------------------------------------------------- */
/* Definition                                                                  */
/* -------------------------------------------------------------------------- */

export interface ReportScopeContext {
  scope: ReportScope
  /** Present exactly when scope === "project". */
  projectId?: string
  projectName?: string
  /** Ambient desk lens — reports filter by it, they never let you change it. */
  divisionId?: string
  communityId?: string
  divisionLabel?: string
  communityLabel?: string
  /** What the report is about: the project name, or the org. */
  scopeLabel: string
  posture: ProjectPosture
}

export interface ReportContext extends ReportScopeContext {
  params: ReportParams
}

/**
 * What the catalog needs to decide whether a report is reachable at all. Every
 * flag is a data gate — "does this org actually have the thing the report is
 * about" — never a `product_tier` gate. A residential org running pay
 * applications sees the pay-app register; a commercial org with no draw
 * schedules never sees Draw Status.
 */
export interface ReportAvailabilityContext {
  scope: ReportScope
  posture: ProjectPosture
  /** True when the org has at least one community — the production data gate. */
  hasCommunities: boolean
  /** True when the org has billed at least one pay application — the progress-billing gate. */
  hasPayApplications: boolean
  /** True when the org has at least one draw schedule — the draw-billing gate. */
  hasDrawSchedules: boolean
  /** True when the org has prequalified at least one company. */
  hasPrequalifications: boolean
}

export interface ReportDefinition {
  slug: string
  title: string
  /** One line for the catalog row. Say what question it answers. */
  summary: string
  /**
   * Posture-specific wording for the catalog row, applied when the viewing
   * scope's posture differs in vocabulary (Client → Owner → Buyer). Falls back
   * to `summary`. This is copy only — availability is never decided here.
   */
  summaryByPosture?: Partial<Record<ProjectPosture, string>>
  group: ReportGroup
  scopes: ReportScope[]
  /** Any-of. Filters the catalog; the service still enforces on its own. */
  permissions: string[]
  /**
   * Data-driven reachability, not a tier gate. A report is hidden only when its
   * subject matter cannot exist for this scope — never because of `product_tier`.
   */
  available?: (ctx: ReportAvailabilityContext) => boolean
  /**
   * Which parts of the ambient lens `run` actually passes down to its service.
   * The viewer names only what is honoured — claiming a community filter the
   * numbers ignore is how a report lies about its own scope. Omit for reports
   * that are always org-wide (WIP, aging, ledgers, 1099).
   */
  ambientScope?: "division" | "full"
  params?: ReportParamSpec[]
  /** Defaults to ["csv", "pdf"]. */
  formats?: ReportFormat[]
  run: (ctx: ReportContext) => Promise<ReportResult>
}
