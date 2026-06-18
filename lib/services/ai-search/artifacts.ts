import "server-only"

import { randomUUID } from "node:crypto"

import type {
  AiArtifactGroup,
  AiArtifactKpi,
  AiArtifactValue,
  AiChartPoint,
  AiChartType,
  AiSearchArtifact,
  AiSearchArtifactDataset,
  AiSearchExportLink,
} from "@/lib/services/ai-search"
import type { AgingBucket } from "@/lib/services/reports/aging"
import type { ARAgingReport } from "@/lib/services/reports/ar-aging"
import type { SearchEntityType, SearchResult } from "@/lib/services/search"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const ARTIFACT_CACHE_TTL_MS = 15 * 60_000

type ProjectRef = {
  id: string
  name: string
}

type FinancialRollup = {
  project?: ProjectRef
  invoiceCount: number
  invoiceTotalCents: number
  paymentCount: number
  paymentTotalCents: number
  budgetCount: number
  budgetTotalCents: number
  estimateCount: number
  estimateTotalCents: number
  commitmentCount: number
  commitmentTotalCents: number
  changeOrderCount: number
  changeOrderTotalCents: number
}

type StructuredIntent = {
  entityType: SearchEntityType
}

type StructuredExecution = {
  relatedResults: SearchResult[]
  statusBreakdown: Array<{ status: string; count: number }>
}

type AnalyticsExecution = {
  entityLabel: string
  project?: ProjectRef | null
  metric: "count" | "sum_amount" | "avg_amount"
  groupBy: "none" | "status" | "project" | "month" | "aging"
  buckets: Array<{
    label: string
    count: number
    amountCents: number
    metricValue: number
  }>
}

type StoredArtifactRow = {
  id: string
  org_id: string
  title: string
  columns: string[] | null
  rows: unknown
  created_at: string
}

const aiArtifactDatasetCache = new Map<string, { expiresAt: number; dataset: AiSearchArtifactDataset }>()

function formatEntityType(type: SearchEntityType) {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function toStatusLabel(status: string) {
  return status.replace(/_/g, " ")
}

function normalizeArtifactRowMatrix(raw: unknown): AiArtifactValue[][] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((row) => {
      if (!Array.isArray(row)) return null
      return row.map((cell) => {
        if (cell === null) return null
        if (typeof cell === "string" || (typeof cell === "number" && Number.isFinite(cell))) {
          return cell
        }
        return String(cell)
      })
    })
    .filter((row): row is AiArtifactValue[] => Array.isArray(row))
}

function toArtifactDatasetFromStorage(row: StoredArtifactRow): AiSearchArtifactDataset {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    columns: Array.isArray(row.columns) ? row.columns.filter((item): item is string => typeof item === "string") : [],
    rows: normalizeArtifactRowMatrix(row.rows),
    createdAt: row.created_at,
  }
}

async function persistArtifactDataset(dataset: AiSearchArtifactDataset) {
  try {
    const supabase = createServiceSupabaseClient()
    const { error } = await supabase.from("ai_search_artifacts").upsert(
      {
        id: dataset.id,
        org_id: dataset.orgId,
        title: dataset.title,
        columns: dataset.columns,
        rows: dataset.rows,
        created_at: dataset.createdAt,
        expires_at: new Date(Date.now() + ARTIFACT_CACHE_TTL_MS).toISOString(),
      },
      { onConflict: "id" },
    )

    if (error) {
      console.error("Failed to persist AI artifact dataset", error)
    }
  } catch (error) {
    console.error("Failed to persist AI artifact dataset", error)
  }
}

async function loadPersistedArtifactDataset(datasetId: string, orgId: string): Promise<AiSearchArtifactDataset | null> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("ai_search_artifacts")
    .select("id,org_id,title,columns,rows,created_at,expires_at")
    .eq("id", datasetId)
    .eq("org_id", orgId)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle()

  if (error) {
    console.error("Failed to load persisted AI artifact dataset", error)
    return null
  }
  if (!data) return null

  const dataset = toArtifactDatasetFromStorage(data as StoredArtifactRow)
  aiArtifactDatasetCache.set(dataset.id, {
    expiresAt: Date.now() + ARTIFACT_CACHE_TTL_MS,
    dataset,
  })
  return dataset
}

function pruneArtifactCache() {
  const now = Date.now()
  for (const [key, value] of aiArtifactDatasetCache.entries()) {
    if (value.expiresAt <= now) {
      aiArtifactDatasetCache.delete(key)
    }
  }
}

function toArtifactValue(value: unknown): AiArtifactValue {
  if (value === null || value === undefined) return null
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "boolean") return value ? "Yes" : "No"
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function isLowSignalArtifactValue(value: AiArtifactValue) {
  if (value === null) return true
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    return normalized.length === 0 || normalized === "-" || normalized === "—" || normalized === "n/a" || normalized === "none"
  }
  return false
}

function artifactDistinctKey(value: AiArtifactValue) {
  if (value === null) return "__null__"
  if (typeof value === "number") return `n:${value}`
  return `s:${value.trim().toLowerCase()}`
}

function pruneLowValueArtifactColumns(columns: string[], rows: AiArtifactValue[][]) {
  if (columns.length <= 1 || rows.length === 0) {
    return { columns, rows }
  }

  const keep = new Set<number>()
  const signalScoreByIndex = new Map<number, number>()
  if (columns.length > 0) keep.add(0)

  for (let index = 0; index < columns.length; index += 1) {
    const label = columns[index]?.trim().toLowerCase() ?? ""
    const sparseThreshold = Math.max(1, Math.ceil(rows.length * 0.2))
    const detailThreshold = Math.max(1, Math.ceil(rows.length * 0.5))
    let nonEmpty = 0
    const distinct = new Set<string>()

    for (const row of rows) {
      const value = row[index] ?? null
      if (isLowSignalArtifactValue(value)) continue
      nonEmpty += 1
      if (distinct.size < 6) {
        distinct.add(artifactDistinctKey(value))
      }
    }

    signalScoreByIndex.set(index, nonEmpty * 10 + Math.min(distinct.size, 6))
    if (index === 0) continue

    if (nonEmpty < sparseThreshold) continue
    if ((label === "details" || label === "description") && nonEmpty < detailThreshold) continue
    if (rows.length >= 3 && distinct.size <= 1) continue
    keep.add(index)
  }

  const minimumColumns = Math.min(2, columns.length)
  if (keep.size < minimumColumns) {
    const fallbackIndices = columns
      .map((_, index) => index)
      .filter((index) => !keep.has(index))
      .sort((a, b) => {
        const scoreA = signalScoreByIndex.get(a) ?? 0
        const scoreB = signalScoreByIndex.get(b) ?? 0
        if (scoreA !== scoreB) return scoreB - scoreA
        return a - b
      })

    for (const index of fallbackIndices) {
      keep.add(index)
      if (keep.size >= minimumColumns) break
    }
  }

  const keepIndices = Array.from(keep).sort((a, b) => a - b)
  return {
    columns: keepIndices.map((index) => columns[index] ?? "Value"),
    rows: rows.map((row) => keepIndices.map((index) => row[index] ?? null)),
  }
}

function normalizeArtifactDatasetInput(columns: string[], rows: AiArtifactValue[][]) {
  const normalizedColumns = columns
    .map((column) => column.trim())
    .filter((column) => column.length > 0)
    .slice(0, 8)
  if (normalizedColumns.length === 0) {
    normalizedColumns.push("Value")
  }

  const normalizedRows = rows.slice(0, 250).map((row) => {
    const nextRow: AiArtifactValue[] = normalizedColumns.map((_, index) => toArtifactValue(row[index]) ?? null)
    return nextRow
  })
  return pruneLowValueArtifactColumns(normalizedColumns, normalizedRows)
}

function storeArtifactDataset(orgId: string, title: string, columns: string[], rows: AiArtifactValue[][]): AiSearchArtifactDataset {
  const normalized = normalizeArtifactDatasetInput(columns, rows)
  const id = randomUUID()
  const dataset: AiSearchArtifactDataset = {
    id,
    orgId,
    title: title.trim() || "AI query export",
    columns: normalized.columns,
    rows: normalized.rows,
    createdAt: new Date().toISOString(),
  }

  aiArtifactDatasetCache.set(id, {
    expiresAt: Date.now() + ARTIFACT_CACHE_TTL_MS,
    dataset,
  })
  void persistArtifactDataset(dataset)

  return dataset
}

function buildExportLinks(datasetId: string): AiSearchExportLink[] {
  const encoded = encodeURIComponent(datasetId)
  return [
    { format: "csv", label: "Export CSV", href: `/api/ai-search/export?datasetId=${encoded}&format=csv` },
    { format: "pdf", label: "Export PDF", href: `/api/ai-search/export?datasetId=${encoded}&format=pdf` },
  ]
}

function buildResultRowsForArtifact(results: SearchResult[]) {
  return results.map((result) => [
    formatEntityType(result.type),
    result.title,
    result.project_name ?? "",
    result.subtitle ?? "",
    result.updated_at ?? "",
  ] satisfies AiArtifactValue[])
}

export function buildTableArtifact({
  orgId,
  title,
  columns,
  rows,
}: {
  orgId: string
  title: string
  columns: string[]
  rows: AiArtifactValue[][]
}): { artifact: AiSearchArtifact; exports: AiSearchExportLink[] } | null {
  if (rows.length === 0) return null
  const dataset = storeArtifactDataset(orgId, title, columns, rows)
  return {
    artifact: {
      kind: "table",
      datasetId: dataset.id,
      title: dataset.title,
      table: {
        columns: dataset.columns,
        rows: dataset.rows.slice(0, 12),
      },
    },
    exports: buildExportLinks(dataset.id),
  }
}

function buildChartArtifact({
  orgId,
  title,
  points,
  valuePrefix,
  valueSuffix,
  type = "bar",
}: {
  orgId: string
  title: string
  points: AiChartPoint[]
  valuePrefix?: string
  valueSuffix?: string
  type?: AiChartType
}): { artifact: AiSearchArtifact; exports: AiSearchExportLink[] } | null {
  const normalizedPoints = points
    .map((point) => ({
      label: point.label.trim(),
      value: Number.isFinite(point.value) ? point.value : 0,
    }))
    .filter((point) => point.label.length > 0 && point.value > 0)
    .slice(0, 12)
  if (normalizedPoints.length === 0) return null

  const resolvedType: AiChartType = type === "stackedBar" ? "bar" : type

  const dataset = storeArtifactDataset(
    orgId,
    title,
    ["Label", "Value"],
    normalizedPoints.map((point) => [point.label, point.value]),
  )

  return {
    artifact: {
      kind: "chart",
      datasetId: dataset.id,
      title: dataset.title,
      chart: {
        type: resolvedType,
        points: normalizedPoints,
        valuePrefix,
        valueSuffix,
      },
    },
    exports: buildExportLinks(dataset.id),
  }
}

// ---------- AR aging report ----------

// Display order for AR aging buckets. `no_due_date` is only surfaced when it
// carries an open balance; `paid` is never shown (those invoices aren't owing).
const AR_AGING_DISPLAY: Array<{ key: Exclude<AgingBucket, "paid">; label: string }> = [
  { key: "current", label: "Current" },
  { key: "1_30", label: "1–30" },
  { key: "31_60", label: "31–60" },
  { key: "61_90", label: "61–90" },
  { key: "90_plus", label: "90+" },
  { key: "no_due_date", label: "No due date" },
]

function moneyFromCents(cents: number) {
  return `$${Math.round(cents / 100).toLocaleString()}`
}

function buildArExportLinks(projectId?: string, asOf?: string): AiSearchExportLink[] {
  const params = new URLSearchParams()
  if (projectId) params.set("projectId", projectId)
  if (asOf) params.set("asOf", asOf)
  const suffix = params.toString() ? `&${params.toString()}` : ""
  return [
    { format: "csv", label: "Export CSV", href: `/api/reports/ar-aging/export?format=csv${suffix}` },
    { format: "pdf", label: "Export PDF", href: `/api/reports/ar-aging/export?format=pdf${suffix}` },
  ]
}

// Builds the full-bleed AR aging report artifact from the canonical
// getArAgingReport result, so AI output matches the /reports figures exactly.
export function buildArArtifact({
  orgId,
  report,
  projectId,
  projectName,
}: {
  orgId: string
  report: ARAgingReport
  projectId?: string
  projectName?: string | null
}): { artifact: AiSearchArtifact; exports: AiSearchExportLink[] } {
  const title = projectName ? `AR aging report — ${projectName}` : "AR aging report"

  // Only invoices that are still owing belong in the aging view.
  const openRows = report.rows.filter((row) => row.bucket !== "paid" && row.open_balance_cents > 0)

  const visibleBuckets = AR_AGING_DISPLAY.filter(
    (entry) => entry.key !== "no_due_date" || report.totals[entry.key] > 0,
  )

  const points: AiChartPoint[] = visibleBuckets.map((entry) => ({
    label: entry.label,
    value: Math.round(report.totals[entry.key] / 100),
  }))

  const groups: AiArtifactGroup[] = visibleBuckets
    .map((entry): AiArtifactGroup | null => {
      const bucketRows = openRows.filter((row) => row.bucket === entry.key)
      if (bucketRows.length === 0 && report.totals[entry.key] === 0) return null
      return {
        label: entry.label,
        count: bucketRows.length,
        total: moneyFromCents(report.totals[entry.key]),
        columns: ["Invoice", "Customer", "Project", "Due", "Days past due", "Open balance"],
        rows: bucketRows
          .slice()
          .sort((a, b) => b.open_balance_cents - a.open_balance_cents)
          .map(
            (row) =>
              [
                row.invoice_number ?? row.title ?? "—",
                row.customer_name ?? "—",
                row.project_name ?? "—",
                row.due_date ?? "—",
                row.days_past_due,
                moneyFromCents(row.open_balance_cents),
              ] satisfies AiArtifactValue[],
          ),
      }
    })
    .filter((group): group is AiArtifactGroup => group !== null)

  const pastDueCents =
    report.totals["1_30"] + report.totals["31_60"] + report.totals["61_90"] + report.totals["90_plus"]
  const kpis: AiArtifactKpi[] = [
    { label: "Total open", value: moneyFromCents(report.totals.total_open_cents) },
    { label: "Open invoices", value: openRows.length.toLocaleString() },
    { label: "Past due", value: moneyFromCents(pastDueCents), tone: pastDueCents > 0 ? "danger" : "neutral" },
  ]

  // Persist a row-per-invoice dataset so the datasetId contract holds (the
  // visible CSV/PDF exports re-run the canonical report instead).
  const dataset = storeArtifactDataset(
    orgId,
    title,
    ["Invoice", "Customer", "Project", "Bucket", "Due", "Days past due", "Open balance (USD)"],
    openRows.map(
      (row) =>
        [
          row.invoice_number ?? row.title ?? "",
          row.customer_name ?? "",
          row.project_name ?? "",
          AR_AGING_DISPLAY.find((entry) => entry.key === row.bucket)?.label ?? row.bucket,
          row.due_date ?? "",
          row.days_past_due,
          Number((row.open_balance_cents / 100).toFixed(2)),
        ] satisfies AiArtifactValue[],
    ),
  )

  return {
    artifact: {
      kind: "report",
      datasetId: dataset.id,
      title,
      reportType: "ar_aging",
      summary: `${openRows.length.toLocaleString()} open ${
        openRows.length === 1 ? "invoice" : "invoices"
      } · ${moneyFromCents(report.totals.total_open_cents)} outstanding as of ${report.as_of}.`,
      kpis,
      chart: { type: "bar", points, valuePrefix: "$" },
      groups,
    },
    exports: buildArExportLinks(projectId, report.as_of),
  }
}

export function buildArtifactForStructuredIntent(
  orgId: string,
  intent: StructuredIntent,
  execution: StructuredExecution,
): { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] } {
  if (execution.statusBreakdown.length > 0) {
    const chart = buildChartArtifact({
      orgId,
      title: `${formatEntityType(intent.entityType)} by status`,
      points: execution.statusBreakdown.map((entry) => ({
        label: toStatusLabel(entry.status),
        value: entry.count,
      })),
    })
    if (chart) return chart
  }

  const table = buildTableArtifact({
    orgId,
    title: `${formatEntityType(intent.entityType)} results`,
    columns: ["Type", "Title", "Project", "Details", "Updated"],
    rows: buildResultRowsForArtifact(execution.relatedResults),
  })
  if (table) return table

  return {}
}

export function buildArtifactForAnalysisIntent({
  orgId,
  project,
  financialRollup,
  relatedResults,
}: {
  orgId: string
  project?: ProjectRef | null
  financialRollup?: FinancialRollup | null
  relatedResults: SearchResult[]
}): { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] } {
  if (financialRollup) {
    const scope = project?.name ? ` - ${project.name}` : ""
    const chart = buildChartArtifact({
      orgId,
      title: `Financial totals${scope}`,
      valuePrefix: "$",
      points: [
        { label: "Invoices", value: Math.round(financialRollup.invoiceTotalCents / 100) },
        { label: "Payments", value: Math.round(financialRollup.paymentTotalCents / 100) },
        { label: "Budgets", value: Math.round(financialRollup.budgetTotalCents / 100) },
        { label: "Estimates", value: Math.round(financialRollup.estimateTotalCents / 100) },
        { label: "Commitments", value: Math.round(financialRollup.commitmentTotalCents / 100) },
        { label: "Change Orders", value: Math.round(financialRollup.changeOrderTotalCents / 100) },
      ],
    })
    if (chart) return chart
  }

  const table = buildTableArtifact({
    orgId,
    title: "Analysis results",
    columns: ["Type", "Title", "Project", "Details", "Updated"],
    rows: buildResultRowsForArtifact(relatedResults),
  })
  if (table) return table

  return {}
}

export function buildArtifactForAnalyticsIntent({
  orgId,
  execution,
  chartType,
}: {
  orgId: string
  execution: AnalyticsExecution
  chartType?: AiChartType
}): { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] } {
  if (execution.buckets.length === 0) {
    return {}
  }

  const valuePrefix = execution.metric === "count" ? undefined : "$"
  const titleSuffix = execution.project?.name ? ` - ${execution.project.name}` : ""
  const baseTitle =
    execution.groupBy === "aging"
      ? "AR aging report"
      : `${execution.entityLabel.replace(/^./, (char) => char.toUpperCase())} analytics`
  const title = `${baseTitle}${titleSuffix}`

  if (execution.groupBy !== "none") {
    const chart = buildChartArtifact({
      orgId,
      title,
      type: chartType ?? (execution.groupBy === "month" ? "line" : "bar"),
      points: execution.buckets.slice(0, 12).map((bucket) => ({
        label: bucket.label,
        value: Number.isFinite(bucket.metricValue) ? bucket.metricValue : 0,
      })),
      valuePrefix,
    })
    if (chart) {
      // Attach a breakdown list so the full-bleed surface can show a
      // collapsible detail table beneath the chart.
      const detailColumns =
        execution.metric === "count" ? ["Group", "Records"] : ["Group", "Value", "Records"]
      chart.artifact.groups = [
        {
          label: "Breakdown",
          count: execution.buckets.length,
          columns: detailColumns,
          rows: execution.buckets.map((bucket) =>
            execution.metric === "count"
              ? ([bucket.label, bucket.count] satisfies AiArtifactValue[])
              : ([
                  bucket.label,
                  `${valuePrefix ?? ""}${Math.round(bucket.metricValue).toLocaleString()}`,
                  bucket.count,
                ] satisfies AiArtifactValue[]),
          ),
        },
      ]
      return chart
    }
  }

  const table = buildTableArtifact({
    orgId,
    title,
    columns: execution.metric === "count" ? ["Group", "Record Count"] : ["Group", "Metric Value", "Record Count", "Amount (USD)"],
    rows: execution.buckets.map((bucket) =>
      execution.metric === "count"
        ? ([bucket.label, bucket.count] satisfies AiArtifactValue[])
        : ([
            bucket.label,
            Number(bucket.metricValue.toFixed(2)),
            bucket.count,
            Number((bucket.amountCents / 100).toFixed(2)),
          ] satisfies AiArtifactValue[]),
    ),
  })
  if (table) return table

  return {}
}

export function buildArtifactForFallback(
  orgId: string,
  relatedResults: SearchResult[],
): { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] } {
  return (
    buildTableArtifact({
      orgId,
      title: "Related records",
      columns: ["Type", "Title", "Project", "Details", "Updated"],
      rows: buildResultRowsForArtifact(relatedResults),
    }) ?? {}
  )
}

export async function getAiSearchArtifactDataset(datasetId: string, orgId: string): Promise<AiSearchArtifactDataset | null> {
  pruneArtifactCache()
  const cached = aiArtifactDatasetCache.get(datasetId)
  if (cached && cached.expiresAt > Date.now() && cached.dataset.orgId === orgId) {
    return cached.dataset
  }

  return loadPersistedArtifactDataset(datasetId, orgId)
}
