"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { useRouter, usePathname } from "next/navigation"
import {
  Building2,
  FileText,
  CheckSquare,
  Search,
  User,
  Users,
  Receipt,
  CreditCard,
  FileSpreadsheet,
  MessageSquare,
  CheckCircle,
  Layers,
  Calendar,
  Camera,
  AlertTriangle,
  Clock,
  Briefcase,
  DollarSign,
  FolderOpen,
  Sparkles,
  Loader2,
  BarChart3,
  Download,
  ArrowRight,
  CornerDownLeft,
  ChevronDown,
  ChevronUp,
  ArrowUp,
  X,
  type LucideIcon,
} from "@/components/icons"

import { AnimatePresence, motion } from "framer-motion"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { useHydrated } from "@/hooks/use-hydrated"
import { cn } from "@/lib/utils"

const SEARCH_TYPES = [
  "project",
  "task",
  "file",
  "contact",
  "company",
  "invoice",
  "payment",
  "budget",
  "estimate",
  "commitment",
  "change_order",
  "contract",
  "proposal",
  "rfi",
  "submittal",
  "drawing_set",
  "drawing_sheet",
  "daily_log",
  "punch_item",
  "schedule_item",
  "photo",
  "portal_access",
  "payable",
  "expense",
  "prospect",
] as const

type SearchType = (typeof SEARCH_TYPES)[number]

const SEARCH_TYPE_SET = new Set<string>(SEARCH_TYPES)
const SEARCH_CACHE_TTL_MS = 20_000
const MIN_LIVE_SEARCH_CHARS = 2
const RECENTS_STORAGE_KEY = "arc.search.recents.v1"
const MAX_RECENT_QUERIES = 5
const MAX_RECENT_ITEMS = 6

// The handful of types offered as quick filter chips above search results.
const FILTERABLE_TYPES: { type: SearchType; label: string }[] = [
  { type: "project", label: "Projects" },
  { type: "contact", label: "Contacts" },
  { type: "company", label: "Companies" },
  { type: "invoice", label: "Invoices" },
  { type: "payable", label: "Payables" },
  { type: "expense", label: "Expenses" },
  { type: "rfi", label: "RFIs" },
  { type: "submittal", label: "Submittals" },
]

interface RecentItem {
  id: string
  type: SearchType
  title: string
  href: string
}

interface SearchRecents {
  queries: string[]
  items: RecentItem[]
}

function loadRecents(): SearchRecents {
  if (typeof window === "undefined") return { queries: [], items: [] }
  try {
    const raw = window.localStorage.getItem(RECENTS_STORAGE_KEY)
    if (!raw) return { queries: [], items: [] }
    const parsed = JSON.parse(raw) as Partial<SearchRecents>
    const queries = Array.isArray(parsed.queries)
      ? parsed.queries.filter((q): q is string => typeof q === "string").slice(0, MAX_RECENT_QUERIES)
      : []
    const items = Array.isArray(parsed.items)
      ? parsed.items
          .filter(
            (item): item is RecentItem =>
              Boolean(item) &&
              typeof item === "object" &&
              isSearchType((item as RecentItem).type) &&
              typeof (item as RecentItem).id === "string" &&
              typeof (item as RecentItem).title === "string" &&
              typeof (item as RecentItem).href === "string",
          )
          .slice(0, MAX_RECENT_ITEMS)
      : []
    return { queries, items }
  } catch {
    return { queries: [], items: [] }
  }
}

function persistRecents(recents: SearchRecents) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(recents))
  } catch {
    // Ignore quota / disabled storage.
  }
}

interface SearchResult {
  id: string
  type: SearchType
  title: string
  subtitle?: string
  description?: string
  href: string
  project_id?: string
  project_name?: string
  created_at?: string
  updated_at?: string
  icon?: LucideIcon
}

interface EntityPreviewRow {
  label: string
  value: string
}

type PreviewCategory = "financial" | "people" | "request" | "schedule" | "document" | "general"
type StatusTone = "success" | "warning" | "danger" | "info" | "neutral"

// Chart kinds Arc can emit. Mirrors AiChartType in lib/services/ai-search.ts
// (kept local because that module is "use server" and can't export consts here).
type AiChartType = "bar" | "horizontalBar" | "line" | "area" | "pie" | "donut" | "stackedBar"
const AI_CHART_TYPES: AiChartType[] = ["bar", "horizontalBar", "line", "area", "pie", "donut", "stackedBar"]

// One-tap analytics prompts shown in the idle state — each produces a chart.
const SUGGESTED_AI_PROMPTS = [
  "AR aging report",
  "Unpaid invoices by age",
  "Invoice totals by month",
  "Open invoices by status",
  "Estimates by status",
]

interface PreviewHeadline {
  value: string
  caption?: string
}

interface EntityPreview {
  id: string
  type: SearchType
  title: string
  category: PreviewCategory
  status?: string
  statusTone?: StatusTone
  headline?: PreviewHeadline
  rows: EntityPreviewRow[]
  description?: string
  projectId?: string
  projectName?: string
  thumbnailUrl?: string
  href: string
}

const PREVIEW_CATEGORIES = new Set<PreviewCategory>(["financial", "people", "request", "schedule", "document", "general"])
const STATUS_TONES = new Set<StatusTone>(["success", "warning", "danger", "info", "neutral"])

// Accent color per category — drives the left bar and the entity icon tint.
const PREVIEW_ACCENT: Record<PreviewCategory, { bar: string; icon: string }> = {
  financial: { bar: "bg-emerald-500", icon: "text-emerald-600 dark:text-emerald-400" },
  people: { bar: "bg-indigo-500", icon: "text-indigo-600 dark:text-indigo-400" },
  request: { bar: "bg-amber-500", icon: "text-amber-600 dark:text-amber-400" },
  schedule: { bar: "bg-teal-500", icon: "text-teal-600 dark:text-teal-400" },
  document: { bar: "bg-violet-500", icon: "text-violet-600 dark:text-violet-400" },
  general: { bar: "bg-slate-400", icon: "text-slate-500 dark:text-slate-400" },
}

// Status pill / inline status text styling per semantic tone.
const STATUS_TONE_STYLES: Record<StatusTone, { dot: string; text: string; chip: string }> = {
  success: { dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400", chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  warning: { dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400", chip: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  danger: { dot: "bg-red-500", text: "text-red-600 dark:text-red-400", chip: "bg-red-500/10 text-red-600 dark:text-red-400" },
  info: { dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400", chip: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  neutral: { dot: "bg-muted-foreground/50", text: "text-muted-foreground", chip: "bg-muted/50 text-muted-foreground" },
}

// Client-side mirror of the server's status→tone mapping, used to color
// statuses parsed out of live-result subtitles (which arrive as plain text).
function statusToneFor(status: string): StatusTone {
  const s = status.toLowerCase()
  if (/(paid|approved|complete|closed|resolved|accepted|active|signed|won|executed|published|answered|installed|done)/.test(s)) {
    return "success"
  }
  if (/(overdue|past[_\s]?due|rejected|fail|void|cancel|declin|expired|lost|disputed|blocked|revise)/.test(s)) {
    return "danger"
  }
  if (/(pending|draft|open|sent|review|submitted|awaiting|hold|partial|in[_\s]?progress|new|requested)/.test(s)) {
    return "warning"
  }
  return "neutral"
}

// Splits a " • "-joined result subtitle into a leading amount, a status token,
// and the remaining descriptive text — so rows can render each distinctly.
function splitSubtitle(subtitle?: string): { amount?: string; status?: string; statusTone?: StatusTone; rest: string } {
  if (!subtitle) return { rest: "" }
  const parts = subtitle.split("•").map((part) => part.trim()).filter(Boolean)
  let amount: string | undefined
  let status: string | undefined
  let statusTone: StatusTone | undefined
  const rest: string[] = []
  for (const part of parts) {
    if (!amount && /^\$[\d,]/.test(part)) {
      amount = part
      continue
    }
    // Only short, plain tokens can be a status — never emails, URLs, or long text.
    if (!status && part.length <= 24 && !/[@/]/.test(part)) {
      const tone = statusToneFor(part)
      if (tone !== "neutral") {
        status = part
        statusTone = tone
        continue
      }
    }
    rest.push(part)
  }
  return { amount, status, statusTone, rest: rest.join(" · ") }
}

interface AiCitation {
  sourceId: string
  id: string
  type: SearchType
  title: string
  href: string
  subtitle?: string
  projectName?: string
  updatedAt?: string
  icon?: LucideIcon
}

interface AiAnswerState {
  answer: string
  citations: AiCitation[]
  relatedResults: SearchResult[]
  actions: AiActionState[]
  workflow?: AiWorkflowState
  generatedAt: string
  sessionId?: string
  assistantMode: "org" | "general"
  mode: "llm" | "fallback"
  provider?: "openai" | "anthropic" | "google"
  model?: string
  configSource?: "org" | "platform" | "env" | "default"
  confidence?: "low" | "medium" | "high"
  missingData?: string[]
  artifact?: {
    kind: "table" | "chart" | "report"
    datasetId: string
    title: string
    reportType?: "ar_aging" | "analytics"
    summary?: string
    kpis?: Array<{ label: string; value: string; tone?: "neutral" | "danger" | "warning" | "success" }>
    groups?: Array<{
      label: string
      total?: string
      count?: number
      columns: string[]
      rows: Array<Array<string | number | null>>
    }>
    table?: {
      columns: string[]
      rows: Array<Array<string | number | null>>
    }
    chart?: {
      type: AiChartType
      points: Array<{ label: string; value: number }>
      series?: Array<{ key: string; label: string }>
      data?: Array<Record<string, string | number | null>>
      valuePrefix?: string
      valueSuffix?: string
    }
  }
  exports?: Array<{
    format: "csv" | "pdf"
    href: string
    label: string
  }>
}

interface AiWorkflowOptionState {
  label: string
  value: string
  description?: string
}

interface AiWorkflowQuestionState {
  slot: string
  label: string
  input: "choice" | "text" | "date" | "number"
  required: boolean
  placeholder?: string
  options?: AiWorkflowOptionState[]
  progress?: { step: number; total: number }
}

interface AiWorkflowPreviewState {
  title: string
  summary: string
  rows: Array<{ label: string; value: string }>
  warnings: string[]
}

interface AiWorkflowState {
  id: string
  workflowKey: string
  title: string
  summary: string
  status: "collecting" | "preview_ready" | "executing" | "executed" | "failed" | "cancelled"
  slots: Record<string, unknown>
  missingSlots: string[]
  questions: AiWorkflowQuestionState[]
  preview?: AiWorkflowPreviewState
  result: Record<string, unknown>
  error?: string
  createdAt: string
  updatedAt: string
  executedAt?: string
}

interface AiActionState {
  id: string
  toolKey: string
  title: string
  summary: string
  status: "proposed" | "running" | "executed" | "rejected" | "failed"
  requiresApproval: boolean
  args: Record<string, unknown>
  result: Record<string, unknown>
  error?: string
  createdAt: string
  updatedAt: string
  executedAt?: string
}

interface AiTraceState {
  id: string
  status: "started" | "running" | "completed" | "warning"
  label: string
  detail?: string
  thought?: string
  timestamp: string
}

interface CommandSearchProps {
  className?: string
}

function isSearchType(value: unknown): value is SearchType {
  return typeof value === "string" && SEARCH_TYPE_SET.has(value)
}

function toSearchResult(raw: unknown) {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>

  if (!isSearchType(value.type)) return null
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.href !== "string") return null

  const normalized: SearchResult = {
    id: value.id,
    type: value.type,
    title: value.title,
    href: value.href,
    subtitle: typeof value.subtitle === "string" ? value.subtitle : undefined,
    description: typeof value.description === "string" ? value.description : undefined,
    project_id: typeof value.project_id === "string" ? value.project_id : undefined,
    project_name: typeof value.project_name === "string" ? value.project_name : undefined,
    created_at: typeof value.created_at === "string" ? value.created_at : undefined,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : undefined,
  }

  return normalized
}

function toEntityPreview(raw: unknown): EntityPreview | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  if (!isSearchType(value.type)) return null
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.href !== "string") return null

  const rows = Array.isArray(value.rows)
    ? value.rows
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null
          const row = entry as Record<string, unknown>
          if (typeof row.label !== "string" || typeof row.value !== "string") return null
          return { label: row.label, value: row.value }
        })
        .filter((row): row is EntityPreviewRow => row !== null)
        .slice(0, 8)
    : []

  const headlineRaw = value.headline
  const headline =
    headlineRaw && typeof headlineRaw === "object" && typeof (headlineRaw as Record<string, unknown>).value === "string"
      ? {
          value: (headlineRaw as Record<string, unknown>).value as string,
          caption:
            typeof (headlineRaw as Record<string, unknown>).caption === "string"
              ? ((headlineRaw as Record<string, unknown>).caption as string)
              : undefined,
        }
      : undefined

  return {
    id: value.id,
    type: value.type,
    title: value.title,
    href: value.href,
    category: PREVIEW_CATEGORIES.has(value.category as PreviewCategory) ? (value.category as PreviewCategory) : "general",
    status: typeof value.status === "string" ? value.status : undefined,
    statusTone: STATUS_TONES.has(value.statusTone as StatusTone) ? (value.statusTone as StatusTone) : undefined,
    headline,
    rows,
    description: typeof value.description === "string" ? value.description : undefined,
    projectId: typeof value.projectId === "string" ? value.projectId : undefined,
    projectName: typeof value.projectName === "string" ? value.projectName : undefined,
    thumbnailUrl: typeof value.thumbnailUrl === "string" ? value.thumbnailUrl : undefined,
  }
}

function toAiCitation(raw: unknown) {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>

  if (!isSearchType(value.type)) return null
  if (
    typeof value.sourceId !== "string" ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.href !== "string"
  ) {
    return null
  }

  const normalized: AiCitation = {
    sourceId: value.sourceId,
    id: value.id,
    type: value.type,
    title: value.title,
    href: value.href,
    subtitle: typeof value.subtitle === "string" ? value.subtitle : undefined,
    projectName: typeof value.projectName === "string" ? value.projectName : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  }

  return normalized
}

function toRelatedResult(raw: unknown) {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>

  if (!isSearchType(value.type)) return null
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.href !== "string") return null

  const normalized: SearchResult = {
    id: value.id,
    type: value.type,
    title: value.title,
    href: value.href,
    subtitle: typeof value.subtitle === "string" ? value.subtitle : undefined,
    description: typeof value.description === "string" ? value.description : undefined,
    project_name: typeof value.projectName === "string" ? value.projectName : undefined,
    updated_at: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
  }

  return normalized
}

type ArtifactKpi = NonNullable<NonNullable<AiAnswerState["artifact"]>["kpis"]>[number]
type ArtifactGroup = NonNullable<NonNullable<AiAnswerState["artifact"]>["groups"]>[number]

function toAiArtifact(raw: unknown): AiAnswerState["artifact"] | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  if (
    (value.kind !== "table" && value.kind !== "chart" && value.kind !== "report") ||
    typeof value.datasetId !== "string" ||
    typeof value.title !== "string"
  ) {
    return undefined
  }

  const reportType = value.reportType === "ar_aging" || value.reportType === "analytics" ? value.reportType : undefined
  const summary = typeof value.summary === "string" ? value.summary : undefined

  const kpis = Array.isArray(value.kpis)
    ? value.kpis
        .map((entry): ArtifactKpi | null => {
          if (!entry || typeof entry !== "object") return null
          const kpi = entry as Record<string, unknown>
          if (typeof kpi.label !== "string" || typeof kpi.value !== "string") return null
          const tone =
            kpi.tone === "danger" || kpi.tone === "warning" || kpi.tone === "success" || kpi.tone === "neutral"
              ? kpi.tone
              : undefined
          return { label: kpi.label, value: kpi.value, tone }
        })
        .filter((kpi): kpi is ArtifactKpi => kpi !== null)
        .slice(0, 4)
    : undefined

  const groups = Array.isArray(value.groups)
    ? value.groups
        .map((entry): ArtifactGroup | null => {
          if (!entry || typeof entry !== "object") return null
          const group = entry as Record<string, unknown>
          if (typeof group.label !== "string") return null
          const columns = Array.isArray(group.columns)
            ? group.columns.filter((column): column is string => typeof column === "string").slice(0, 8)
            : []
          if (columns.length === 0) return null
          const rows = Array.isArray(group.rows)
            ? group.rows
                .map((row): Array<string | number | null> | null =>
                  Array.isArray(row)
                    ? row.map((cell) => (typeof cell === "number" || typeof cell === "string" || cell === null ? cell : String(cell)))
                    : null,
                )
                .filter((row): row is Array<string | number | null> => row !== null)
                .slice(0, 200)
            : []
          return {
            label: group.label,
            total: typeof group.total === "string" ? group.total : undefined,
            count: typeof group.count === "number" ? group.count : undefined,
            columns,
            rows,
          }
        })
        .filter((group): group is ArtifactGroup => group !== null)
        .slice(0, 12)
    : undefined

  const table =
    value.table && typeof value.table === "object"
      ? (() => {
          const tableValue = value.table as Record<string, unknown>
          const columns = Array.isArray(tableValue.columns)
            ? tableValue.columns.filter((column): column is string => typeof column === "string").slice(0, 8)
            : []
          const rows = Array.isArray(tableValue.rows)
            ? tableValue.rows
                .map((row) => (Array.isArray(row) ? row.map((cell) => (typeof cell === "number" || typeof cell === "string" || cell === null ? cell : String(cell))) : null))
                .filter((row): row is Array<string | number | null> => Array.isArray(row))
                .slice(0, 30)
            : []
          if (columns.length === 0) return undefined
          return { columns, rows }
        })()
      : undefined

  const chart =
    value.chart && typeof value.chart === "object"
      ? (() => {
          const chartValue = value.chart as Record<string, unknown>
          const type = AI_CHART_TYPES.includes(chartValue.type as AiChartType)
            ? (chartValue.type as AiChartType)
            : "bar"
          const points = Array.isArray(chartValue.points)
            ? chartValue.points
                .map((point) => {
                  if (!point || typeof point !== "object") return null
                  const pointValue = point as Record<string, unknown>
                  if (typeof pointValue.label !== "string" || typeof pointValue.value !== "number") return null
                  return {
                    label: pointValue.label,
                    value: pointValue.value,
                  }
                })
                .filter((point): point is { label: string; value: number } => Boolean(point))
                .slice(0, 12)
            : []

          const series = Array.isArray(chartValue.series)
            ? chartValue.series
                .map((entry) => {
                  if (!entry || typeof entry !== "object") return null
                  const seriesValue = entry as Record<string, unknown>
                  if (typeof seriesValue.key !== "string" || typeof seriesValue.label !== "string") return null
                  return { key: seriesValue.key, label: seriesValue.label }
                })
                .filter((entry): entry is { key: string; label: string } => Boolean(entry))
                .slice(0, 8)
            : undefined

          const data = Array.isArray(chartValue.data)
            ? chartValue.data
                .filter((row): row is Record<string, string | number | null> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
                .slice(0, 24)
            : undefined

          if (points.length === 0 && !(series && series.length > 0 && data && data.length > 0)) return undefined

          return {
            type,
            points,
            series,
            data,
            valuePrefix: typeof chartValue.valuePrefix === "string" ? chartValue.valuePrefix : undefined,
            valueSuffix: typeof chartValue.valueSuffix === "string" ? chartValue.valueSuffix : undefined,
          }
        })()
      : undefined

  return {
    kind: value.kind,
    datasetId: value.datasetId,
    title: value.title,
    reportType,
    summary,
    kpis,
    groups,
    table,
    chart,
  }
}

function toAiExportLinks(raw: unknown): AiAnswerState["exports"] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null
      const value = item as Record<string, unknown>
      if ((value.format !== "csv" && value.format !== "pdf") || typeof value.href !== "string" || typeof value.label !== "string") {
        return null
      }
      return {
        format: value.format,
        href: value.href,
        label: value.label,
      } as const
    })
    .filter((item): item is NonNullable<AiAnswerState["exports"]>[number] => Boolean(item))
}

function toAiActionState(raw: unknown): AiActionState | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  if (
    typeof value.id !== "string" ||
    typeof value.toolKey !== "string" ||
    typeof value.title !== "string" ||
    typeof value.summary !== "string" ||
    (value.status !== "proposed" &&
      value.status !== "running" &&
      value.status !== "executed" &&
      value.status !== "rejected" &&
      value.status !== "failed")
  ) {
    return null
  }

  const args = value.args && typeof value.args === "object" && !Array.isArray(value.args) ? (value.args as Record<string, unknown>) : {}
  const result =
    value.result && typeof value.result === "object" && !Array.isArray(value.result) ? (value.result as Record<string, unknown>) : {}

  return {
    id: value.id,
    toolKey: value.toolKey,
    title: value.title,
    summary: value.summary,
    status: value.status,
    requiresApproval: value.requiresApproval === false ? false : true,
    args,
    result,
    error: typeof value.error === "string" ? value.error : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    executedAt: typeof value.executedAt === "string" ? value.executedAt : undefined,
  }
}

function toAiWorkflowState(raw: unknown): AiWorkflowState | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  if (
    typeof value.id !== "string" ||
    typeof value.workflowKey !== "string" ||
    typeof value.title !== "string" ||
    typeof value.summary !== "string" ||
    (value.status !== "collecting" &&
      value.status !== "preview_ready" &&
      value.status !== "executing" &&
      value.status !== "executed" &&
      value.status !== "failed" &&
      value.status !== "cancelled")
  ) {
    return undefined
  }

  const questions = Array.isArray(value.questions)
    ? value.questions
        .map((rawQuestion): AiWorkflowQuestionState | null => {
          if (!rawQuestion || typeof rawQuestion !== "object") return null
          const question = rawQuestion as Record<string, unknown>
          if (
            typeof question.slot !== "string" ||
            typeof question.label !== "string" ||
            (question.input !== "choice" && question.input !== "text" && question.input !== "date" && question.input !== "number")
          ) {
            return null
          }
          const options = Array.isArray(question.options)
            ? question.options
                .map((rawOption): AiWorkflowOptionState | null => {
                  if (!rawOption || typeof rawOption !== "object") return null
                  const option = rawOption as Record<string, unknown>
                  if (typeof option.label !== "string" || typeof option.value !== "string") return null
                  return {
                    label: option.label,
                    value: option.value,
                    description: typeof option.description === "string" ? option.description : undefined,
                  }
                })
                .filter((option): option is AiWorkflowOptionState => Boolean(option))
            : undefined
          const progressRaw = question.progress
          const progress =
            progressRaw &&
            typeof progressRaw === "object" &&
            typeof (progressRaw as Record<string, unknown>).step === "number" &&
            typeof (progressRaw as Record<string, unknown>).total === "number"
              ? {
                  step: (progressRaw as Record<string, number>).step,
                  total: (progressRaw as Record<string, number>).total,
                }
              : undefined
          return {
            slot: question.slot,
            label: question.label,
            input: question.input,
            required: question.required === false ? false : true,
            placeholder: typeof question.placeholder === "string" ? question.placeholder : undefined,
            options,
            progress,
          }
        })
        .filter((question): question is AiWorkflowQuestionState => Boolean(question))
    : []

  const previewRecord = value.preview && typeof value.preview === "object" ? (value.preview as Record<string, unknown>) : null
  const preview =
    previewRecord && typeof previewRecord.title === "string" && typeof previewRecord.summary === "string"
      ? {
          title: previewRecord.title,
          summary: previewRecord.summary,
          rows: Array.isArray(previewRecord.rows)
            ? previewRecord.rows
                .map((rawRow): { label: string; value: string } | null => {
                  if (!rawRow || typeof rawRow !== "object") return null
                  const row = rawRow as Record<string, unknown>
                  if (typeof row.label !== "string" || typeof row.value !== "string") return null
                  return { label: row.label, value: row.value }
                })
                .filter((row): row is { label: string; value: string } => Boolean(row))
            : [],
          warnings: Array.isArray(previewRecord.warnings)
            ? previewRecord.warnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0)
            : [],
        }
      : undefined

  return {
    id: value.id,
    workflowKey: value.workflowKey,
    title: value.title,
    summary: value.summary,
    status: value.status,
    slots: value.slots && typeof value.slots === "object" && !Array.isArray(value.slots) ? (value.slots as Record<string, unknown>) : {},
    missingSlots: Array.isArray(value.missingSlots) ? value.missingSlots.filter((item): item is string => typeof item === "string") : [],
    questions,
    preview,
    result: value.result && typeof value.result === "object" && !Array.isArray(value.result) ? (value.result as Record<string, unknown>) : {},
    error: typeof value.error === "string" ? value.error : undefined,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    executedAt: typeof value.executedAt === "string" ? value.executedAt : undefined,
  }
}

function toAiTraceState(raw: unknown): AiTraceState | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  if (
    typeof value.id !== "string" ||
    (value.status !== "started" && value.status !== "running" && value.status !== "completed" && value.status !== "warning") ||
    typeof value.label !== "string"
  ) {
    return null
  }

  return {
    id: value.id,
    status: value.status,
    label: value.label,
    detail: typeof value.detail === "string" ? value.detail : undefined,
    thought: typeof value.thought === "string" ? value.thought : undefined,
    timestamp: typeof value.timestamp === "string" ? value.timestamp : new Date().toISOString(),
  }
}

function toAiAnswerState(raw: unknown) {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>

  if (typeof value.answer !== "string") return null

  const citations = Array.isArray(value.citations)
    ? value.citations.map(toAiCitation).filter((citation): citation is AiCitation => Boolean(citation))
    : []

  const relatedResults = Array.isArray(value.relatedResults)
    ? value.relatedResults.map(toRelatedResult).filter((result): result is SearchResult => Boolean(result))
    : []
  const actions = Array.isArray(value.actions)
    ? value.actions.map(toAiActionState).filter((item): item is AiActionState => Boolean(item))
    : []

  const state: AiAnswerState = {
    answer: value.answer,
    citations,
    relatedResults,
    actions,
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : new Date().toISOString(),
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    assistantMode: value.assistantMode === "general" ? "general" : "org",
    mode: value.mode === "llm" ? "llm" : "fallback",
    provider:
      value.provider === "openai" || value.provider === "anthropic" || value.provider === "google"
        ? value.provider
        : undefined,
    model: typeof value.model === "string" ? value.model : undefined,
    configSource:
      value.configSource === "org" ||
      value.configSource === "platform" ||
      value.configSource === "env" ||
      value.configSource === "default"
        ? value.configSource
        : undefined,
    confidence: value.confidence === "high" || value.confidence === "medium" || value.confidence === "low" ? value.confidence : undefined,
    missingData: Array.isArray(value.missingData)
      ? value.missingData.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 4)
      : undefined,
    artifact: toAiArtifact(value.artifact),
    exports: toAiExportLinks(value.exports),
    workflow: toAiWorkflowState(value.workflow),
  }

  return state
}

function getIconForType(type: SearchType): LucideIcon {
  switch (type) {
    case "project":
      return Building2
    case "task":
      return CheckSquare
    case "file":
      return FileText
    case "contact":
      return User
    case "company":
      return Users
    case "invoice":
      return Receipt
    case "payment":
      return CreditCard
    case "budget":
      return DollarSign
    case "estimate":
      return FileSpreadsheet
    case "commitment":
      return Briefcase
    case "change_order":
      return CheckCircle
    case "contract":
      return FileText
    case "proposal":
      return CheckCircle
    case "rfi":
      return AlertTriangle
    case "submittal":
      return CheckCircle
    case "drawing_set":
    case "drawing_sheet":
      return Layers
    case "daily_log":
      return Calendar
    case "punch_item":
      return AlertTriangle
    case "schedule_item":
      return Clock
    case "photo":
      return Camera
    case "portal_access":
      return FolderOpen
    case "payable":
      return Receipt
    case "expense":
      return CreditCard
    case "prospect":
      return Users
    default:
      return FileText
  }
}

function getTypeColor(type: SearchType) {
  switch (type) {
    case "project":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300"
    case "task":
      return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
    case "file":
      return "bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-300"
    case "contact":
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300"
    case "company":
      return "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300"
    case "invoice":
    case "payment":
    case "budget":
    case "estimate":
    case "commitment":
    case "change_order":
    case "contract":
    case "proposal":
    case "payable":
    case "expense":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300"
    case "rfi":
    case "submittal":
      return "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300"
    case "drawing_set":
    case "drawing_sheet":
      return "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300"
    case "daily_log":
    case "schedule_item":
      return "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-300"
    case "punch_item":
      return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300"
    case "photo":
    case "portal_access":
      return "bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-300"
    case "prospect":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300"
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300"
  }
}

function formatEntityType(type: SearchType): string {
  return type
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (Number.isNaN(diffDays) || diffDays < 0) return ""
  if (diffDays === 0) return "today"
  if (diffDays === 1) return "yesterday"
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  return `${Math.floor(diffDays / 30)}mo ago`
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Highlights occurrences of the query's word tokens within a result field.
function highlightMatch(text: string, query: string): ReactNode {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1)
  if (tokens.length === 0) return text

  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "ig")
  const segments = text.split(pattern)
  if (segments.length <= 1) return text

  const tokenSet = new Set(tokens)
  return segments.map((segment, index) =>
    tokenSet.has(segment.toLowerCase()) ? (
      <mark key={`${segment}-${index}`} className="bg-transparent font-semibold text-foreground">
        {segment}
      </mark>
    ) : (
      <span key={`${segment}-${index}`}>{segment}</span>
    ),
  )
}

function formatArtifactValue(value: string | number | null | undefined, prefix?: string, suffix?: string) {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "number") {
    const text = Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    return `${prefix ?? ""}${text}${suffix ?? ""}`
  }
  return value
}

// ---------- Chart rendering ----------

const AI_CHART_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
]

// Compact axis labels: $12.5k, 1.2M, etc.
function formatChartTick(value: number, prefix?: string, suffix?: string): string {
  if (!Number.isFinite(value)) return ""
  const abs = Math.abs(value)
  let text: string
  if (abs >= 1_000_000) text = `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  else if (abs >= 1_000) text = `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  else text = value.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return `${prefix ?? ""}${text}${suffix ?? ""}`
}

function truncateChartLabel(value: string): string {
  return value.length > 14 ? `${value.slice(0, 13)}…` : value
}

function AiChart({
  chart,
  containerClass = "aspect-auto h-[200px] w-full",
}: {
  chart: NonNullable<NonNullable<AiAnswerState["artifact"]>["chart"]>
  containerClass?: string
}) {
  const { type, points, series, data, valuePrefix, valueSuffix } = chart
  const isMulti = Boolean(series && series.length > 0 && data && data.length > 0)

  const config: ChartConfig = isMulti
    ? Object.fromEntries(
        (series ?? []).map((entry, index) => [
          entry.key,
          { label: entry.label, color: AI_CHART_PALETTE[index % AI_CHART_PALETTE.length] },
        ]),
      )
    : { value: { label: valuePrefix ? "Amount" : "Value", color: AI_CHART_PALETTE[0] } }

  const chartData = isMulti ? data! : points.map((point) => ({ label: point.label, value: point.value }))
  const tickFormatter = (value: number) => formatChartTick(value, valuePrefix, valueSuffix)

  // Pie / donut — composition of a single series.
  if ((type === "pie" || type === "donut") && !isMulti) {
    return (
      <ChartContainer config={config} className={containerClass}>
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent nameKey="label" hideLabel />} />
          <Pie
            data={chartData}
            dataKey="value"
            nameKey="label"
            innerRadius={type === "donut" ? 44 : 0}
            outerRadius={72}
            strokeWidth={1}
          >
            {chartData.map((_, index) => (
              <Cell key={index} fill={AI_CHART_PALETTE[index % AI_CHART_PALETTE.length]} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
    )
  }

  // Line / area — trends. Supports multi-series.
  if (type === "line" || type === "area") {
    const seriesKeys = isMulti ? (series ?? []).map((entry) => entry.key) : ["value"]
    const Chart = type === "area" ? AreaChart : LineChart
    return (
      <ChartContainer config={config} className={containerClass}>
        <Chart data={chartData} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} fontSize={10} tickFormatter={truncateChartLabel} />
          <YAxis tickLine={false} axisLine={false} width={44} fontSize={10} tickFormatter={tickFormatter} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {seriesKeys.map((key, index) => {
            const color = AI_CHART_PALETTE[index % AI_CHART_PALETTE.length]
            return type === "area" ? (
              <Area key={key} dataKey={key} type="monotone" stroke={color} fill={color} fillOpacity={0.15} strokeWidth={2} />
            ) : (
              <Line key={key} dataKey={key} type="monotone" stroke={color} strokeWidth={2} dot={false} />
            )
          })}
        </Chart>
      </ChartContainer>
    )
  }

  // Horizontal bar — ranked categories / long labels.
  if (type === "horizontalBar") {
    return (
      <ChartContainer config={config} className={containerClass}>
        <BarChart data={chartData} layout="vertical" margin={{ left: 4, right: 12, top: 4, bottom: 4 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" />
          <XAxis type="number" tickLine={false} axisLine={false} fontSize={10} tickFormatter={tickFormatter} />
          <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={96} fontSize={10} tickFormatter={truncateChartLabel} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="value" fill={AI_CHART_PALETTE[0]} radius={0} />
        </BarChart>
      </ChartContainer>
    )
  }

  // Bar / stackedBar — default.
  const barSeriesKeys = isMulti ? (series ?? []).map((entry) => entry.key) : ["value"]
  return (
    <ChartContainer config={config} className={containerClass}>
      <BarChart data={chartData} margin={{ left: 4, right: 8, top: 8, bottom: 4 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} fontSize={10} tickFormatter={truncateChartLabel} />
        <YAxis tickLine={false} axisLine={false} width={44} fontSize={10} tickFormatter={tickFormatter} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {barSeriesKeys.map((key, index) => (
          <Bar
            key={key}
            dataKey={key}
            stackId={type === "stackedBar" ? "stack" : undefined}
            fill={AI_CHART_PALETTE[index % AI_CHART_PALETTE.length]}
            radius={0}
          />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

// ---------- Full-bleed report surface ----------

type ReportArtifact = NonNullable<AiAnswerState["artifact"]>
type ReportGroup = ArtifactGroup

const REPORT_KPI_TONE: Record<NonNullable<NonNullable<ReportArtifact["kpis"]>[number]["tone"]>, string> = {
  neutral: "text-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
}

// One collapsible detail section (e.g. an AR aging bucket). Collapsed by default.
function ReportGroupSection({ group }: { group: ReportGroup }) {
  const [open, setOpen] = useState(false)
  const hasRows = group.rows.length > 0

  return (
    <div className="border-t border-border/40 first:border-t-0">
      <button
        type="button"
        onClick={() => hasRows && setOpen((prev) => !prev)}
        disabled={!hasRows}
        className="flex w-full items-center gap-2 py-2.5 text-left transition-colors hover:bg-accent/40 disabled:cursor-default disabled:hover:bg-transparent"
      >
        {hasRows ? (
          open ? (
            <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <span className="text-sm font-medium text-foreground">{group.label}</span>
        {typeof group.count === "number" && (
          <span className="text-xs text-muted-foreground/70">
            {group.count} {group.count === 1 ? "item" : "items"}
          </span>
        )}
        {group.total && <span className="ml-auto text-sm font-medium tabular-nums text-foreground">{group.total}</span>}
      </button>
      {open && hasRows && (
        <div className="overflow-x-auto pb-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border/40">
                {group.columns.map((column) => (
                  <th key={column} className="px-2 py-1.5 text-left font-medium text-muted-foreground">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row, rowIndex) => (
                <tr key={`${group.label}-row-${rowIndex}`} className="border-b border-border/20 last:border-b-0">
                  {group.columns.map((column, columnIndex) => (
                    <td
                      key={`${column}-${rowIndex}`}
                      className={cn(
                        "px-2 py-1.5 text-foreground/80",
                        columnIndex === group.columns.length - 1 && "text-right tabular-nums",
                      )}
                    >
                      {formatArtifactValue(row[columnIndex])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Full-bleed report layout used whenever the AI emits an artifact (a canonical
// report like AR aging, or any analytics chart). Drops the chat chrome.
function ReportView({
  artifact,
  exports,
}: {
  artifact: ReportArtifact
  exports: AiAnswerState["exports"]
}) {
  const kpis = artifact.kpis ?? []
  const groups = artifact.groups ?? []

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-5 pt-4 pb-2">
        <Sparkles className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-base font-semibold text-foreground">{artifact.title}</h2>
      </div>
      {artifact.summary && <p className="px-5 pb-1 text-sm text-muted-foreground">{artifact.summary}</p>}

      {/* KPIs */}
      {kpis.length > 0 && (
        <div className="grid grid-cols-2 gap-px border-y border-border/40 bg-border/40 sm:grid-cols-3">
          {kpis.map((kpi) => (
            <div key={kpi.label} className="bg-popover px-5 py-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70">{kpi.label}</div>
              <div className={cn("mt-0.5 text-xl font-semibold tabular-nums", REPORT_KPI_TONE[kpi.tone ?? "neutral"])}>
                {kpi.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Chart */}
      {artifact.chart && (
        <div className="px-5 pt-4 pb-2">
          <AiChart chart={artifact.chart} containerClass="aspect-auto h-[260px] w-full" />
        </div>
      )}

      {/* Collapsible detail list */}
      {groups.length > 0 && (
        <div className="px-5 pt-1">
          {groups.map((group) => (
            <ReportGroupSection key={group.label} group={group} />
          ))}
        </div>
      )}

      {/* Exports */}
      {exports && exports.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/40 px-5 py-4">
          {exports.map((item) => (
            <Button key={item.href} asChild type="button" size="sm" variant="outline" className="h-8 rounded-none text-xs">
              <a href={item.href} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                <Download className="mr-1.5 size-3.5" />
                {item.label}
              </a>
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- AI Response Components ----------

function toTraceSentence(item: AiTraceState) {
  const raw = (item.thought ?? item.detail ?? item.label).trim()
  if (!raw) return "Working on your request."
  return /[.!?]$/.test(raw) ? raw : `${raw}.`
}

function AiLoadingIndicator({ trace }: { trace: AiTraceState[] }) {
  const items = trace.slice(-28)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: "smooth",
    })
  }, [items.length])

  return (
    <div className="flex items-start gap-3 px-5 py-4">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/40">
        <Sparkles className="size-3.5 text-muted-foreground" />
      </div>
      <div className="flex-1 space-y-2 pt-0.5">
        <div className="rounded-none border border-border/40 bg-muted/20 p-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">Reasoning Stream</div>
          <div ref={viewportRef} className="h-28 space-y-1 overflow-y-auto pr-1">
            <AnimatePresence initial={false}>
              {items.map((item) => (
                <motion.div
                  key={`${item.id}-${item.timestamp}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.2 }}
                  className="flex items-start gap-2 text-xs"
                >
                  <span
                    className={cn(
                      "mt-1 size-1.5 shrink-0 rounded-full",
                      item.status === "completed" && "bg-emerald-400/80",
                      item.status === "warning" && "bg-amber-400/80",
                      (item.status === "started" || item.status === "running") && "bg-cyan-400/80",
                    )}
                  />
                  <p className="min-w-0 leading-relaxed text-foreground/90">{toTraceSentence(item)}</p>
                </motion.div>
              ))}
            </AnimatePresence>
            {items.length === 0 && <p className="text-xs text-muted-foreground">Preparing planner...</p>}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          <span>Running org-scoped agent...</span>
        </div>
      </div>
    </div>
  )
}

// Cyan accent that matches the command bar's "AI" treatment (input border + shockwave).
const WF_ACCENT = "oklch(0.62 0.16 215)"
const WF_HIGHLIGHT_BG = "oklch(0.62 0.16 215 / 0.1)"
const WF_BORDER = "oklch(0.62 0.16 215 / 0.6)"

// Full-bleed guided-workflow experience: the assistant asks one question at a
// time and the user picks an answer from a numbered list (1–9 / arrows / enter)
// or types a custom value via the "/" row. Designed to feel like a sharp,
// keyboard-first command surface rather than a chat transcript.
function AiWorkflowExperience({
  workflow,
  onRespond,
  onExecute,
  onCancel,
  onNavigate,
  isExecuting,
}: {
  workflow: AiWorkflowState
  onRespond: (workflowId: string, value: string) => void
  onExecute: (workflowId: string) => void
  onCancel: () => void
  onNavigate: (href: string) => void
  isExecuting: boolean
}) {
  const question = workflow.questions[0]
  const options = useMemo(() => question?.options ?? [], [question])
  const [highlighted, setHighlighted] = useState(0)
  const [customMode, setCustomMode] = useState(false)
  const [textValue, setTextValue] = useState("")
  const [isAdvancing, setIsAdvancing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const textInputRef = useRef<HTMLInputElement>(null)

  const filteredOptions = useMemo(() => {
    const query = customMode ? textValue.trim().toLowerCase() : ""
    if (!query) return options
    return options.filter((option) => {
      const haystack = `${option.label} ${option.description ?? ""}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [customMode, options, textValue])
  const hasOptions = question?.input === "choice" && options.length > 0
  const freeTextIndex = filteredOptions.length

  const resultHref = typeof workflow.result.href === "string" ? workflow.result.href : undefined
  const resultSummary = typeof workflow.result.summary === "string" ? workflow.result.summary : undefined

  // Reset interaction state whenever the active question (or stage) changes.
  const stageKey = question?.slot ?? workflow.status
  useEffect(() => {
    setHighlighted(0)
    setCustomMode(false)
    setTextValue("")
    setIsAdvancing(false)
  }, [stageKey])

  // Keep the keyboard focused on the answer surface so 1–9 / arrows work without
  // a click. Choice questions focus the list; free-text questions focus the input.
  useEffect(() => {
    if (workflow.status !== "collecting" || !question) return
    if (!hasOptions) {
      textInputRef.current?.focus()
      return
    }
    if (!customMode) containerRef.current?.focus()
  }, [stageKey, hasOptions, customMode, workflow.status, question])

  const submitText = (raw?: string) => {
    const value = (raw ?? textValue).trim()
    if (!value) return
    setIsAdvancing(true)
    onRespond(workflow.id, value)
    setTextValue("")
    setCustomMode(false)
  }

  const submitChoice = (value: string) => {
    if (isAdvancing) return
    setIsAdvancing(true)
    onRespond(workflow.id, value)
  }

  const enterCustomMode = () => {
    setCustomMode(true)
    setHighlighted(freeTextIndex)
    requestAnimationFrame(() => textInputRef.current?.focus())
  }

  const handleSubmitButton = () => {
    if (isAdvancing) return
    if (!hasOptions) {
      submitText()
      return
    }
    if (customMode || highlighted >= filteredOptions.length) {
      if (textValue.trim()) submitText()
      else enterCustomMode()
      return
    }
    submitChoice(filteredOptions[highlighted].value)
  }

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keystrokes inside the free-text / single inputs bubble up here too; let
    // those inputs own their own handling rather than treating "1" as a pick.
    if (event.target instanceof HTMLInputElement) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setHighlighted((prev) => Math.min(prev + 1, freeTextIndex))
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setHighlighted((prev) => Math.max(prev - 1, 0))
      return
    }
    if (event.key === "/" && !customMode) {
      event.preventDefault()
      enterCustomMode()
      return
    }
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1
      if (index < filteredOptions.length) {
        event.preventDefault()
        submitChoice(filteredOptions[index].value)
      }
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      if (highlighted >= filteredOptions.length) enterCustomMode()
      else submitChoice(filteredOptions[highlighted].value)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      onCancel()
    }
  }

  const renderNumberBadge = (content: ReactNode, active: boolean) => (
    <span
      className="flex size-5 shrink-0 items-center justify-center border font-mono text-[11px]"
      style={
        active
          ? { borderColor: WF_BORDER, color: WF_ACCENT }
          : { borderColor: "var(--border)", color: "var(--muted-foreground)" }
      }
    >
      {content}
    </span>
  )

  // --- Header ---------------------------------------------------------------
  const header = (
    <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
      <div className="flex min-w-0 items-center gap-2">
        <Sparkles className="size-3.5 shrink-0" style={{ color: WF_ACCENT }} />
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {workflow.title}
        </span>
      </div>
      {workflow.status === "collecting" && question?.progress && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
          {question.progress.step} of {question.progress.total}
        </span>
      )}
      {workflow.status === "preview_ready" && (
        <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground/60">Review</span>
      )}
    </div>
  )

  // --- Collecting -----------------------------------------------------------
  if (workflow.status === "collecting" && question) {
    return (
      <div className="flex flex-col">
        {header}
        <div ref={containerRef} tabIndex={-1} onKeyDown={handleListKeyDown} className="outline-none">
          <motion.div
            key={stageKey}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="px-5 pb-3 text-[15px] font-medium leading-snug text-foreground"
          >
            {question.label}
          </motion.div>

          {hasOptions ? (
            <div>
              {filteredOptions.map((option, index) => {
                const active = index === highlighted && !customMode
                const showDescription = option.description && option.description !== option.label
                return (
                  <button
                    key={option.value}
                    type="button"
                    onMouseEnter={() => {
                      setHighlighted(index)
                      setCustomMode(false)
                    }}
                    disabled={isAdvancing}
                    onClick={() => submitChoice(option.value)}
                    className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors"
                    style={active ? { backgroundColor: WF_HIGHLIGHT_BG } : undefined}
                  >
                    {renderNumberBadge(index + 1, active)}
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">{option.label}</span>
                    {showDescription && (
                      <span className="hidden shrink-0 truncate text-xs text-muted-foreground/60 sm:block">
                        {option.description}
                      </span>
                    )}
                  </button>
                )
              })}
              {customMode && textValue.trim() && filteredOptions.length === 0 && (
                <div className="px-5 py-2 text-xs text-muted-foreground">
                  No matching options. Press Enter to use “{textValue.trim()}”.
                </div>
              )}

              {/* Free-text "/" escape hatch — type a value the options don't cover. */}
              <div
                className="flex items-center gap-3 px-5 py-2.5 transition-colors"
                style={highlighted === freeTextIndex && !customMode ? { backgroundColor: WF_HIGHLIGHT_BG } : undefined}
              >
                {renderNumberBadge("/", customMode || highlighted === freeTextIndex)}
                <input
                  ref={textInputRef}
                  value={textValue}
                  onChange={(event) => setTextValue(event.target.value)}
                  onFocus={() => {
                    setCustomMode(true)
                    setHighlighted(freeTextIndex)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      submitText()
                    } else if (event.key === "Escape") {
                      event.preventDefault()
                      setCustomMode(false)
                      setTextValue("")
                      containerRef.current?.focus()
                    }
                  }}
                  placeholder={question.placeholder ?? "Type a different answer"}
                  inputMode={question.input === "number" ? "decimal" : undefined}
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/40"
                  disabled={isAdvancing}
                />
              </div>
            </div>
          ) : (
            <div className="px-5 pb-1">
              <input
                ref={textInputRef}
                value={textValue}
                onChange={(event) => setTextValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    submitText()
                  } else if (event.key === "Escape") {
                    event.preventDefault()
                    onCancel()
                  }
                }}
                placeholder={question.placeholder ?? "Type your answer"}
                inputMode={question.input === "number" ? "decimal" : undefined}
                className="h-10 w-full border border-border/60 bg-background px-3 text-sm text-foreground outline-none focus:border-[oklch(0.62_0.16_215_/_0.6)]"
                disabled={isAdvancing}
                autoFocus
              />
            </div>
          )}
          {isAdvancing && (
            <div className="flex items-center gap-1.5 px-5 pt-2 pb-1 text-xs text-muted-foreground">
              <span>Arc is writing the next question</span>
              <span className="flex gap-0.5">
                <span className="size-1 animate-bounce rounded-full bg-current [animation-delay:-0.2s]" />
                <span className="size-1 animate-bounce rounded-full bg-current [animation-delay:-0.1s]" />
                <span className="size-1 animate-bounce rounded-full bg-current" />
              </span>
            </div>
          )}
        </div>

        <WorkflowFooter onCancel={onCancel} onSubmit={handleSubmitButton} disabled={isAdvancing} />
      </div>
    )
  }

  // --- Preview ready --------------------------------------------------------
  if (workflow.status === "preview_ready" || workflow.status === "executing") {
    return (
      <div className="flex flex-col">
        {header}
        {workflow.preview && (
          <>
            <div className="px-5 pb-1 text-[15px] font-medium leading-snug text-foreground">
              {workflow.preview.summary}
            </div>
            <dl className="mt-3 divide-y divide-border/40 border-t border-border/40">
              {workflow.preview.rows.map((row) => (
                <div key={row.label} className="grid grid-cols-[130px_1fr] gap-4 px-5 py-2.5">
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground/60">{row.label}</dt>
                  <dd className="min-w-0 break-words text-sm text-foreground">{row.value}</dd>
                </div>
              ))}
            </dl>
            {workflow.preview.warnings.length > 0 && (
              <div className="space-y-1 border-t border-border/40 px-5 py-3">
                {workflow.preview.warnings.map((warning) => (
                  <div key={warning} className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                    <span>{warning}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        <div className="flex items-center justify-between border-t border-border/40 px-5 py-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Cancel
          </button>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5 rounded-none text-xs"
            disabled={isExecuting || workflow.status === "executing"}
            onClick={() => onExecute(workflow.id)}
          >
            {isExecuting || workflow.status === "executing" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <CheckCircle className="size-3" />
            )}
            {isExecuting || workflow.status === "executing" ? "Creating…" : "Create invoice"}
          </Button>
        </div>
      </div>
    )
  }

  // --- Executed -------------------------------------------------------------
  if (workflow.status === "executed") {
    return (
      <div className="flex flex-col">
        {header}
        <div className="flex items-start gap-3 px-5 pb-4">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <CheckCircle className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-sm text-foreground">{resultSummary ?? "Done."}</p>
            {resultHref && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 rounded-none text-xs"
                onClick={() => onNavigate(resultHref)}
              >
                Open invoice
                <ArrowRight className="size-3" />
              </Button>
            )}
          </div>
        </div>
      </div>
    )
  }

  // --- Failed / cancelled ---------------------------------------------------
  return (
    <div className="flex flex-col">
      {header}
      <div className="flex items-start gap-3 px-5 pb-4">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-foreground">{workflow.error ?? "This workflow was cancelled."}</p>
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Start over
          </button>
        </div>
      </div>
    </div>
  )
}

// Shared footer for the collecting stage: Cancel on the left, a circular submit
// affordance on the right (mirrors the reference's send button).
function WorkflowFooter({ onCancel, onSubmit, disabled = false }: { onCancel: () => void; onSubmit: () => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between border-t border-border/40 px-5 py-2.5">
      <button
        type="button"
        onClick={onCancel}
        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onSubmit}
        disabled={disabled}
        aria-label="Submit answer"
        className="flex size-7 items-center justify-center border border-border/60 text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ArrowUp className="size-3.5" />
      </button>
    </div>
  )
}

function AiResponsePanel({
  aiAnswer,
  aiError,
  submittedQuery,
  onRetry,
  onNavigate,
  onExecuteAction,
  onRespondToWorkflow,
  onExecuteWorkflow,
  onCancel,
  executingActionId,
  executingWorkflowId,
}: {
  aiAnswer: AiAnswerState
  aiError: string | null
  submittedQuery: string
  onRetry: () => void
  onNavigate: (href: string) => void
  onExecuteAction: (actionId: string) => void
  onRespondToWorkflow: (workflowId: string, value: string) => void
  onExecuteWorkflow: (workflowId: string) => void
  onCancel: () => void
  executingActionId: string | null
  executingWorkflowId: string | null
}) {
  const [sourcesExpanded, setSourcesExpanded] = useState(false)
  const citationKeys = useMemo(() => new Set(aiAnswer.citations.map((citation) => `${citation.type}:${citation.id}`)), [aiAnswer.citations])
  const nonDuplicateRelated = useMemo(
    () => aiAnswer.relatedResults.filter((result) => !citationKeys.has(`${result.type}:${result.id}`)),
    [aiAnswer.relatedResults, citationKeys],
  )

  if (aiError) {
    return (
      <div className="px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive/10 ring-1 ring-destructive/30">
            <AlertTriangle className="size-3.5 text-destructive" />
          </div>
          <div className="flex-1 space-y-2 pt-0.5">
            <p className="text-sm text-muted-foreground">{aiError}</p>
            <Button type="button" size="sm" variant="outline" className="h-7 rounded-none text-xs" onClick={onRetry}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Guided workflows get a dedicated, full-bleed, keyboard-first surface instead
  // of the chat-style answer layout (no avatars, confidence chips, or citations).
  if (aiAnswer.workflow) {
    return (
      <AiWorkflowExperience
        workflow={aiAnswer.workflow}
        onRespond={onRespondToWorkflow}
        onExecute={onExecuteWorkflow}
        onCancel={onCancel}
        onNavigate={onNavigate}
        isExecuting={executingWorkflowId === aiAnswer.workflow.id}
      />
    )
  }

  // Analytics/report artifacts render in a dedicated full-bleed surface instead
  // of the chat-style answer (no user echo, avatar, confidence chip, or summary).
  if (aiAnswer.artifact && (aiAnswer.artifact.kind === "report" || aiAnswer.artifact.kind === "chart")) {
    return <ReportView artifact={aiAnswer.artifact} exports={aiAnswer.exports} />
  }

  return (
    <div className="px-5 py-4">
      {/* User question */}
      <div className="mb-4 flex items-start gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/5 ring-1 ring-border">
          <User className="size-3.5 text-muted-foreground" />
        </div>
        <p className="pt-0.5 text-sm font-medium text-foreground">{submittedQuery}</p>
      </div>

      {/* AI answer */}
      <div className="flex items-start gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/40">
          <Sparkles className="size-3.5 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1 space-y-3 pt-0.5">
          {aiAnswer.confidence && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge
                variant="secondary"
                className={cn(
                  "rounded-none px-1.5 py-0 text-[10px]",
                  aiAnswer.confidence === "high" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                  aiAnswer.confidence === "medium" && "bg-blue-500/10 text-blue-600 dark:text-blue-400",
                  aiAnswer.confidence === "low" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
                )}
              >
                Confidence: {aiAnswer.confidence}
              </Badge>
            </div>
          )}

          {aiAnswer.assistantMode === "general" && (
            <div className="rounded-none border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
              This response is not grounded in company-record citations.
            </div>
          )}

          {aiAnswer.missingData && aiAnswer.missingData.length > 0 && (
            <div className="rounded-none border border-border/50 bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground">
              Missing data: {aiAnswer.missingData.join(" ")}
            </div>
          )}

          {/* Answer text */}
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{aiAnswer.answer}</div>

          {/* Action approvals */}
          {aiAnswer.actions.length > 0 && (
            <div className="space-y-2 rounded-none border border-border/60 bg-muted/20 p-2.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Proposed Actions</div>
              <div className="space-y-2">
                {aiAnswer.actions.slice(0, 4).map((action) => {
                  const isExecuting = executingActionId === action.id
                  const resultSummary = typeof action.result.summary === "string" ? action.result.summary : undefined
                  const resultHref = typeof action.result.href === "string" ? action.result.href : undefined

                  return (
                    <div key={action.id} className="rounded-none border border-border/50 bg-background/70 p-2.5">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant="secondary"
                          className={cn(
                            "rounded-none px-1.5 py-0 text-[10px]",
                            action.status === "proposed" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                            action.status === "running" && "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
                            action.status === "executed" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                            action.status === "rejected" && "bg-muted text-muted-foreground",
                            action.status === "failed" && "bg-destructive/10 text-destructive",
                          )}
                        >
                          {action.status}
                        </Badge>
                        <span className="text-xs font-medium text-foreground">{action.title}</span>
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">{action.summary}</p>

                      {action.status === "proposed" && (
                        <div className="mt-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 rounded-none text-xs"
                            disabled={isExecuting}
                            onClick={() => onExecuteAction(action.id)}
                          >
                            {isExecuting ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : <CheckCircle className="mr-1.5 size-3" />}
                            {isExecuting ? "Executing..." : "Execute"}
                          </Button>
                        </div>
                      )}

                      {action.status === "executed" && resultSummary && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
                          <CheckCircle className="size-3" />
                          <span>{resultSummary}</span>
                          {resultHref && (
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-xs underline"
                              onClick={() => onNavigate(resultHref)}
                            >
                              Open
                              <ArrowRight className="size-3" />
                            </button>
                          )}
                        </div>
                      )}

                      {action.status === "running" && (
                        <div className="mt-2 flex items-center gap-2 text-xs text-cyan-700 dark:text-cyan-300">
                          <Loader2 className="size-3 animate-spin" />
                          <span>Execution in progress...</span>
                        </div>
                      )}

                      {action.status === "failed" && action.error && (
                        <div className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
                          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                          <span>{action.error}</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Artifact: Table */}
          {aiAnswer.artifact?.kind === "table" && aiAnswer.artifact.table && (
            <div className="overflow-hidden rounded-none border border-border/60">
              <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-xs font-medium text-foreground">
                <BarChart3 className="size-3.5 text-muted-foreground" />
                {aiAnswer.artifact.title}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/50">
                      {aiAnswer.artifact.table.columns.map((column) => (
                        <th key={column} className="px-3 py-2 text-left font-medium text-muted-foreground">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {aiAnswer.artifact.table.rows.slice(0, 8).map((row, rowIndex) => (
                      <tr key={`${aiAnswer.artifact?.datasetId}-row-${rowIndex}`} className="border-b border-border/30 last:border-b-0">
                        {aiAnswer.artifact!.table!.columns.map((column, columnIndex) => (
                          <td key={`${column}-${rowIndex}`} className="px-3 py-1.5 text-foreground/80">
                            {formatArtifactValue(row[columnIndex])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Artifact: Chart */}
          {aiAnswer.artifact?.kind === "chart" && aiAnswer.artifact.chart && (
            <div className="overflow-hidden rounded-none border border-border/60">
              <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-xs font-medium text-foreground">
                <BarChart3 className="size-3.5 text-muted-foreground" />
                {aiAnswer.artifact.title}
              </div>
              <div className="px-3 py-3">
                <AiChart chart={aiAnswer.artifact.chart} />
              </div>
            </div>
          )}

          {/* Export buttons */}
          {aiAnswer.exports && aiAnswer.exports.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {aiAnswer.exports.map((item) => (
                <Button key={item.href} asChild type="button" size="sm" variant="outline" className="h-7 rounded-none text-xs">
                  <a href={item.href} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                    <Download className="mr-1.5 size-3" />
                    {item.label}
                  </a>
                </Button>
              ))}
            </div>
          )}

          {/* Sources */}
          {aiAnswer.citations.length > 0 && (
            <div className="border-t border-border/40 pt-2">
              <button
                type="button"
                onClick={() => setSourcesExpanded(!sourcesExpanded)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {sourcesExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                {aiAnswer.citations.length} source{aiAnswer.citations.length !== 1 ? "s" : ""}
              </button>
              {sourcesExpanded && (
                <div className="mt-2 space-y-1">
                  {aiAnswer.citations.map((citation) => {
                    const IconComponent = citation.icon ?? getIconForType(citation.type)
                    return (
                      <button
                        key={`${citation.sourceId}-${citation.id}`}
                        type="button"
                        onClick={() => onNavigate(citation.href)}
                        className="flex w-full items-center gap-2.5 rounded-none px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
                      >
                        <IconComponent className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{citation.title}</span>
                        <Badge variant="secondary" className={`${getTypeColor(citation.type)} shrink-0 text-[10px]`}>
                          {citation.sourceId}
                        </Badge>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Related results */}
          {nonDuplicateRelated.length > 0 && (
            <div className="border-t border-border/40 pt-2">
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Related</div>
              <div className="space-y-0.5">
                {nonDuplicateRelated.slice(0, 5).map((result) => {
                  const IconComponent = result.icon ?? getIconForType(result.type)
                  return (
                    <button
                      key={`${result.type}-${result.id}`}
                      type="button"
                      onClick={() => onNavigate(result.href)}
                      className="flex w-full items-center gap-2.5 rounded-none px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
                    >
                      <IconComponent className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground">{result.title}</span>
                      {result.project_name && (
                        <span className="shrink-0 truncate text-[10px] text-muted-foreground">in {result.project_name}</span>
                      )}
                      <ArrowRight className="size-3 shrink-0 text-muted-foreground/50" />
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Meta */}
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
            <span>{aiAnswer.mode === "llm" ? "AI" : "Summary"}</span>
            {aiAnswer.provider && (
              <>
                <span>·</span>
                <span className="capitalize">{aiAnswer.provider}</span>
              </>
            )}
            {aiAnswer.model && (
              <>
                <span>·</span>
                <span>{aiAnswer.model}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Renders a single fact value, turning emails / phones / websites into links.
function PreviewFactValue({ row }: { row: EntityPreviewRow }) {
  const label = row.label.toLowerCase()
  const stop = (event: React.MouseEvent) => event.stopPropagation()
  if (label === "email") {
    return (
      <a href={`mailto:${row.value}`} onClick={stop} className="truncate text-foreground underline-offset-2 hover:underline">
        {row.value}
      </a>
    )
  }
  if (label === "phone") {
    return (
      <a href={`tel:${row.value}`} onClick={stop} className="truncate text-foreground underline-offset-2 hover:underline">
        {row.value}
      </a>
    )
  }
  if (label === "website") {
    const href = /^https?:\/\//i.test(row.value) ? row.value : `https://${row.value}`
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={stop}
        className="truncate text-foreground underline-offset-2 hover:underline"
      >
        {row.value}
      </a>
    )
  }
  return <span className="truncate">{row.value}</span>
}

// Visual peek for file / photo / drawing previews. Fades in once loaded and
// removes itself if the image can't be fetched (404 / not-ready / no CDN).
function PreviewThumbnail({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  if (failed) return null
  return (
    <div className="relative mt-4 flex min-h-[140px] items-center justify-center overflow-hidden border border-border/50 bg-muted/30">
      {!loaded && <div className="absolute inset-0 animate-pulse bg-muted/50" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={cn(
          "max-h-64 w-full object-contain transition-opacity duration-200",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  )
}

function EntityPreviewPanel({
  result,
  preview,
  isLoading,
  error,
}: {
  result: SearchResult
  preview: EntityPreview | null
  isLoading: boolean
  error: string | null
}) {
  const Icon = result.icon ?? getIconForType(result.type)
  const title = preview?.title ?? result.title
  const status = preview?.status
  const tone = STATUS_TONE_STYLES[preview?.statusTone ?? "neutral"]
  const projectName = preview?.projectName ?? result.project_name
  const category = preview?.category ?? "general"
  const accent = PREVIEW_ACCENT[category]
  const headline = preview?.headline

  return (
    <div className="flex">
      <div className="min-w-0 flex-1 px-5 py-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-none border border-border/60 bg-muted/30">
            <Icon className={cn("size-4", accent.icon)} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 truncate text-base font-medium leading-tight text-foreground">{title}</h3>
              {status && (
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium",
                    tone.chip,
                  )}
                >
                  <span className={cn("size-1.5 rounded-full", tone.dot)} />
                  {status}
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{formatEntityType(result.type)}</span>
              {projectName && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="truncate">{projectName}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="min-h-[40px]">
          {isLoading && (
            <div className="mt-4 space-y-3">
              <div className="h-7 w-32 animate-pulse rounded-none bg-muted/60" />
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/40 pt-4">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="space-y-1.5">
                    <div className="h-2.5 w-12 animate-pulse rounded-none bg-muted/50" />
                    <div className="h-3 w-20 animate-pulse rounded-none bg-muted/60" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {!isLoading && error && <p className="py-3 text-xs text-muted-foreground">{error}</p>}

          {!isLoading && !error && preview && (
            <>
              {/* Visual thumbnail (files, photos, drawings) */}
              {preview.thumbnailUrl && <PreviewThumbnail src={preview.thumbnailUrl} alt={title} />}

              {/* Hero metric */}
              {headline && (
                <div className="mt-4">
                  <div className="text-2xl font-semibold leading-none tracking-tight tabular-nums text-foreground">
                    {headline.value}
                  </div>
                  {headline.caption && <div className="mt-1 text-xs text-muted-foreground">{headline.caption}</div>}
                </div>
              )}

              {/* What it's about */}
              {preview.description && (
                <p
                  className={cn(
                    "line-clamp-3 text-sm leading-relaxed text-foreground/80",
                    headline ? "mt-3" : "mt-4",
                  )}
                >
                  {preview.description}
                </p>
              )}

              {/* Facts grid */}
              {preview.rows.length > 0 && (
                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/40 pt-4">
                  {preview.rows.map((row) => (
                    <div key={`${row.label}-${row.value}`} className="min-w-0">
                      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
                        {row.label}
                      </dt>
                      <dd className="mt-0.5 flex min-w-0 text-xs font-medium text-foreground">
                        <PreviewFactValue row={row} />
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- Main Component ----------

type ViewMode = "idle" | "search" | "ai" | "preview"
export function CommandSearch({ className }: CommandSearchProps) {
  const [open, setOpen] = useState(false)
  const [aiEnabled, setAiEnabled] = useState(true)
  const aiConfigLoadedRef = useRef(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isAskingAi, setIsAskingAi] = useState(false)
  const [aiAnswer, setAiAnswer] = useState<AiAnswerState | null>(null)
  const [aiSessionId, setAiSessionId] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiTrace, setAiTrace] = useState<AiTraceState[]>([])
  const [executingActionId, setExecutingActionId] = useState<string | null>(null)
  const [executingWorkflowId, setExecutingWorkflowId] = useState<string | null>(null)
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [showGlow, setShowGlow] = useState(false)
  const [shockwaveKey, setShockwaveKey] = useState(0)
  const [previewResult, setPreviewResult] = useState<SearchResult | null>(null)
  const [preview, setPreview] = useState<EntityPreview | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [typeFilters, setTypeFilters] = useState<SearchType[]>([])
  const [scopeToProject, setScopeToProject] = useState(false)
  const [recents, setRecents] = useState<SearchRecents>({ queries: [], items: [] })
  const hydrated = useHydrated()
  const router = useRouter()
  const pathname = usePathname()
  const askRequestIdRef = useRef(0)
  const aiAbortRef = useRef<AbortController | null>(null)
  const searchAbortRef = useRef<AbortController | null>(null)
  const previewAbortRef = useRef<AbortController | null>(null)
  const searchCacheRef = useRef<Map<string, { expiresAt: number; results: SearchResult[] }>>(new Map())
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsContainerRef = useRef<HTMLDivElement>(null)

  const viewMode: ViewMode =
    isAskingAi || aiAnswer || aiError ? "ai" : previewResult ? "preview" : query.trim() ? "search" : "idle"

  // Detect the project the user is currently viewing so search can be scoped to it.
  const currentProjectId = useMemo(() => {
    const match = pathname?.match(/^\/projects\/([0-9a-f-]{36})(?:\/|$)/i)
    return match ? match[1] : null
  }, [pathname])
  const projectScopeActive = scopeToProject && Boolean(currentProjectId)

  const recordRecents = useCallback((result: SearchResult, usedQuery: string) => {
    setRecents((prev) => {
      const trimmed = usedQuery.trim()
      const queries =
        trimmed.length >= MIN_LIVE_SEARCH_CHARS
          ? [trimmed, ...prev.queries.filter((q) => q.toLowerCase() !== trimmed.toLowerCase())].slice(0, MAX_RECENT_QUERIES)
          : prev.queries
      const item: RecentItem = { id: result.id, type: result.type, title: result.title, href: result.href }
      const items = [item, ...prev.items.filter((i) => !(i.type === item.type && i.id === item.id))].slice(0, MAX_RECENT_ITEMS)
      const next = { queries, items }
      persistRecents(next)
      return next
    })
  }, [])

  const flatResults = useMemo(() => {
    return results.map((result) => ({
      ...result,
      icon: getIconForType(result.type),
    }))
  }, [results])

  const groupedSearchResults = useMemo(() => {
    const grouped: Record<string, SearchResult[]> = {}
    flatResults.forEach((result) => {
      const typeLabel = `${formatEntityType(result.type)}s`
      if (!grouped[typeLabel]) grouped[typeLabel] = []
      grouped[typeLabel].push(result)
    })
    return grouped
  }, [flatResults])

  const closeAiStream = useCallback(() => {
    if (!aiAbortRef.current) return
    aiAbortRef.current.abort()
    aiAbortRef.current = null
  }, [])

  const searchItems = useCallback(async (searchQuery: string): Promise<SearchResult[]> => {
    const trimmedQuery = searchQuery.trim()
    if (trimmedQuery.length < MIN_LIVE_SEARCH_CHARS) return []
    let controller: AbortController | null = null

    try {
      const now = Date.now()
      for (const [key, value] of searchCacheRef.current.entries()) {
        if (value.expiresAt <= now) {
          searchCacheRef.current.delete(key)
        }
      }

      const typesParam = typeFilters.length > 0 ? [...typeFilters].sort().join(",") : ""
      const projectParam = projectScopeActive && currentProjectId ? currentProjectId : ""
      const cacheKey = `${trimmedQuery.toLowerCase()}|${typesParam}|${projectParam}`
      const cached = searchCacheRef.current.get(cacheKey)
      if (cached && cached.expiresAt > now) {
        return cached.results
      }

      searchAbortRef.current?.abort()
      controller = new AbortController()
      searchAbortRef.current = controller

      const params = new URLSearchParams({
        q: trimmedQuery,
        limit: "20",
      })
      if (typesParam) params.set("types", typesParam)
      if (projectParam) params.set("projectId", projectParam)
      const response = await fetch(`/api/search?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`Search request failed (${response.status})`)
      }

      const payload = (await response.json().catch(() => ({}))) as { results?: unknown }
      const normalizedResults = Array.isArray(payload.results)
        ? payload.results.map(toSearchResult).filter((result): result is SearchResult => Boolean(result))
        : []

      searchCacheRef.current.set(cacheKey, {
        expiresAt: now + SEARCH_CACHE_TTL_MS,
        results: normalizedResults,
      })
      return normalizedResults
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return []
      }
      console.error("Search failed:", error)
      return []
    } finally {
      if (controller && searchAbortRef.current === controller) {
        searchAbortRef.current = null
      }
    }
  }, [typeFilters, projectScopeActive, currentProjectId])

  const askAi = useCallback(
    async (overrideQuery?: string) => {
      if (!aiEnabled) return
      const prompt = (overrideQuery ?? query).trim()
      if (!prompt) return

      const requestId = ++askRequestIdRef.current
      closeAiStream()
      setIsAskingAi(true)
      setAiError(null)
      setAiAnswer(null)
      setAiTrace([])
      setExecutingActionId(null)
      setSubmittedQuery(prompt)

      // Fire shockwave + turn on steady glow
      setShockwaveKey((prev) => prev + 1)
      setShowGlow(true)

      const abortController = new AbortController()
      aiAbortRef.current = abortController
      let hasTerminalEvent = false

      const finalizeWithError = (message: string) => {
        if (askRequestIdRef.current !== requestId) return
        hasTerminalEvent = true
        setAiAnswer(null)
        setAiError(message)
        setIsAskingAi(false)
        closeAiStream()
      }

      const parsePayload = (raw: string) => {
        try {
          return JSON.parse(raw) as unknown
        } catch {
          return null
        }
      }

      const handleStreamEvent = (eventName: string, rawData: string) => {
        if (askRequestIdRef.current !== requestId) return
        const payload = parsePayload(rawData)
        if (eventName === "trace") {
          const traceItem = toAiTraceState(payload)
          if (!traceItem) return
          setAiTrace((prev) => [...prev, traceItem].slice(-24))
          return
        }

        if (eventName === "result") {
          const normalized = toAiAnswerState(payload)
          if (!normalized) {
            finalizeWithError("The AI response format was invalid. Please try again.")
            return
          }

          hasTerminalEvent = true
          setAiSessionId((prev) => normalized.sessionId ?? prev)
          setAiAnswer({
            ...normalized,
            citations: normalized.citations.map((citation) => ({
              ...citation,
              icon: getIconForType(citation.type),
            })),
            relatedResults: normalized.relatedResults.map((result) => ({
              ...result,
              icon: getIconForType(result.type),
            })),
          })
          setIsAskingAi(false)
          closeAiStream()
          return
        }

        if (eventName === "error") {
          if (payload && typeof payload === "object" && typeof (payload as { message?: unknown }).message === "string") {
            finalizeWithError((payload as { message: string }).message)
            return
          }
          finalizeWithError("Something went wrong while streaming the response. Please try again.")
        }
      }

      try {
        const response = await fetch("/api/ai-search/stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            q: prompt,
            limit: 20,
            sessionId: aiSessionId ?? undefined,
            currentProjectId: currentProjectId ?? undefined,
          }),
          signal: abortController.signal,
        })

        if (!response.ok || !response.body) {
          finalizeWithError("Unable to start AI stream. Please try again.")
          return
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          while (true) {
            const splitAt = buffer.indexOf("\n\n")
            if (splitAt === -1) break
            const block = buffer.slice(0, splitAt)
            buffer = buffer.slice(splitAt + 2)

            if (!block.trim()) continue

            let eventName = "message"
            const dataLines: string[] = []
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim()
              } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trim())
              }
            }

            handleStreamEvent(eventName, dataLines.join("\n"))
          }
        }

        if (!hasTerminalEvent && askRequestIdRef.current === requestId) {
          finalizeWithError("The stream ended before a complete response was received.")
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          return
        }
        console.error("AI stream request failed:", error)
        finalizeWithError("Something went wrong while streaming the response. Please try again.")
      } finally {
        if (aiAbortRef.current === abortController) {
          aiAbortRef.current = null
        }
      }
    },
    [aiEnabled, aiSessionId, closeAiStream, currentProjectId, query],
  )

  // Resolve whether the AI affordances should be shown for this org (once, on first open).
  useEffect(() => {
    if (!open || aiConfigLoadedRef.current) return
    aiConfigLoadedRef.current = true
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch("/api/ai-search/config", { cache: "no-store" })
        if (!response.ok) return
        const payload = (await response.json().catch(() => ({}))) as { enabled?: unknown }
        if (!cancelled && typeof payload.enabled === "boolean") {
          setAiEnabled(payload.enabled)
        }
      } catch {
        // Leave the default (enabled) in place; the server still gates the actual request.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // Load recent searches/items from localStorage each time the palette opens.
  useEffect(() => {
    if (open) setRecents(loadRecents())
  }, [open])

  // Keyboard shortcut to open
  useEffect(() => {
    const down = (event: globalThis.KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort()
      closeAiStream()
    }
  }, [closeAiStream])

  // Reset on close
  useEffect(() => {
    if (!open) {
      askRequestIdRef.current += 1
      searchAbortRef.current?.abort()
      closeAiStream()
      setQuery("")
      setResults([])
      setIsLoading(false)
      setIsAskingAi(false)
      setAiAnswer(null)
      setAiSessionId(null)
      setAiError(null)
      setAiTrace([])
      setExecutingActionId(null)
      setExecutingWorkflowId(null)
      setSubmittedQuery("")
      setSelectedIndex(-1)
      setShowGlow(false)
      previewAbortRef.current?.abort()
      setPreviewResult(null)
      setPreview(null)
      setPreviewError(null)
      setIsPreviewLoading(false)
      setTypeFilters([])
      setScopeToProject(false)
    }
  }, [closeAiStream, open])

  // Live search while typing
  useEffect(() => {
    let isCancelled = false
    const search = async () => {
      if (query.trim().length < MIN_LIVE_SEARCH_CHARS) {
        searchAbortRef.current?.abort()
        setResults([])
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      try {
        const searchResults = await searchItems(query)
        if (!isCancelled) setResults(searchResults)
      } catch {
        if (!isCancelled) setResults([])
      } finally {
        if (!isCancelled) setIsLoading(false)
      }
    }

    const debounceTimer = setTimeout(search, 100)
    return () => {
      isCancelled = true
      clearTimeout(debounceTimer)
    }
  }, [query, searchItems])

  // Clear AI + preview when query changes (typing returns to the results list)
  useEffect(() => {
    setAiAnswer(null)
    setAiError(null)
    setAiTrace([])
    setExecutingActionId(null)
    setExecutingWorkflowId(null)
    setSelectedIndex(-1)
    previewAbortRef.current?.abort()
    setPreviewResult(null)
    setPreview(null)
    setPreviewError(null)
    setIsPreviewLoading(false)
  }, [query])

  const handleNavigate = useCallback(
    (href: string) => {
      setOpen(false)
      router.push(href)
    },
    [router],
  )

  const closePreview = useCallback(() => {
    previewAbortRef.current?.abort()
    previewAbortRef.current = null
    setPreviewResult(null)
    setPreview(null)
    setPreviewError(null)
    setIsPreviewLoading(false)
    inputRef.current?.focus()
  }, [])

  // Opens the morphing preview for a result (the "pre-step" before navigating).
  const openPreview = useCallback((result: SearchResult) => {
    previewAbortRef.current?.abort()
    const controller = new AbortController()
    previewAbortRef.current = controller

    recordRecents(result, query)
    setPreviewResult(result)
    setPreview(null)
    setPreviewError(null)
    setIsPreviewLoading(true)

    void (async () => {
      try {
        const params = new URLSearchParams({ type: result.type, id: result.id })
        const response = await fetch(`/api/search/preview?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        })
        const payload = (await response.json().catch(() => ({}))) as { preview?: unknown }
        if (controller.signal.aborted) return
        const normalized = toEntityPreview(payload.preview)
        setPreview(normalized)
        if (!normalized) setPreviewError("Couldn't load details. You can still open the record.")
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        setPreviewError("Couldn't load details. You can still open the record.")
      } finally {
        if (previewAbortRef.current === controller) {
          previewAbortRef.current = null
          setIsPreviewLoading(false)
        }
      }
    })()
  }, [recordRecents, query])

  const executeProposedAction = useCallback(async (actionId: string) => {
    const trimmedActionId = actionId.trim()
    if (!trimmedActionId) return

    setExecutingActionId(trimmedActionId)
    try {
      const idempotencyKey = `ui_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      const runActionRequest = async (dryRun: boolean) => {
        const response = await fetch("/api/ai-search/actions/execute", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            actionId: trimmedActionId,
            dryRun,
            idempotencyKey,
          }),
        })
        const payload = (await response.json().catch(() => ({}))) as { action?: unknown; error?: unknown }
        if (!response.ok) {
          throw new Error(typeof payload.error === "string" ? payload.error : "Unable to execute action.")
        }
        const action = toAiActionState(payload.action)
        if (!action) {
          throw new Error("Action response was invalid.")
        }
        return action
      }

      const preview = await runActionRequest(true)
      const previewSummary = typeof preview.result.summary === "string" ? preview.result.summary : "Preview completed."
      setAiTrace((prev) =>
        [
          ...prev,
          {
            id: `action-preview-${preview.id}-${Date.now()}`,
            status: "running",
            label: "Action preview",
            detail: previewSummary,
            thought: "Validation passed. Executing the action now.",
            timestamp: new Date().toISOString(),
          } satisfies AiTraceState,
        ].slice(-24),
      )

      const executed = await runActionRequest(false)

      setAiAnswer((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          actions: prev.actions.map((action) => (action.id === executed.id ? executed : action)),
        }
      })

      const actionTrace: AiTraceState = {
        id: `action-executed-${executed.id}-${Date.now()}`,
        status: executed.status === "executed" ? "completed" : "warning",
        label: executed.status === "executed" ? "Action executed" : "Action update",
        detail:
          executed.status === "executed"
            ? typeof executed.result.summary === "string"
              ? executed.result.summary
              : "Action completed."
            : executed.error ?? "Action did not complete.",
        thought:
          executed.status === "executed"
            ? "Action executed successfully."
            : "Action execution returned a warning.",
        timestamp: new Date().toISOString(),
      }
      setAiTrace((prev) => [...prev, actionTrace].slice(-24))
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to execute action."
      setAiAnswer((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          actions: prev.actions.map((action) =>
            action.id === trimmedActionId
              ? {
                  ...action,
                  status: "failed",
                  error: message,
                }
              : action,
          ),
        }
      })
      const failedTrace: AiTraceState = {
        id: `action-failed-${trimmedActionId}-${Date.now()}`,
        status: "warning",
        label: "Action failed",
        detail: message,
        thought: "Action execution failed. You can revise the request and retry.",
        timestamp: new Date().toISOString(),
      }
      setAiTrace((prev) => [...prev, failedTrace].slice(-24))
    } finally {
      setExecutingActionId((current) => (current === trimmedActionId ? null : current))
    }
  }, [])

  const respondToWorkflow = useCallback(async (workflowId: string, value: string) => {
    const trimmedWorkflowId = workflowId.trim()
    const trimmedValue = value.trim()
    if (!trimmedWorkflowId || !trimmedValue) return

    try {
      const response = await fetch("/api/ai-search/workflows/respond", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workflowId: trimmedWorkflowId,
          value: trimmedValue,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as { workflow?: unknown; error?: unknown }
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Unable to update workflow.")
      }
      const workflow = toAiWorkflowState(payload.workflow)
      if (!workflow) throw new Error("Workflow response was invalid.")
      setAiAnswer((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          workflow,
          answer: workflow.status === "preview_ready"
            ? "I have enough to prepare this invoice. Review the preview, then confirm when you want me to create it."
            : workflow.questions[0]?.label ?? prev.answer,
          missingData: workflow.missingSlots,
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to update workflow."
      setAiTrace((prev) =>
        [
          ...prev,
          {
            id: `workflow-update-failed-${trimmedWorkflowId}-${Date.now()}`,
            status: "warning",
            label: "Workflow update failed",
            detail: message,
            thought: "The workflow response could not be saved.",
            timestamp: new Date().toISOString(),
          } satisfies AiTraceState,
        ].slice(-24),
      )
    }
  }, [])

  const executeWorkflow = useCallback(async (workflowId: string) => {
    const trimmedWorkflowId = workflowId.trim()
    if (!trimmedWorkflowId) return

    setExecutingWorkflowId(trimmedWorkflowId)
    try {
      const response = await fetch("/api/ai-search/workflows/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ workflowId: trimmedWorkflowId }),
      })
      const payload = (await response.json().catch(() => ({}))) as { workflow?: unknown; error?: unknown }
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Unable to execute workflow.")
      }
      const workflow = toAiWorkflowState(payload.workflow)
      if (!workflow) throw new Error("Workflow response was invalid.")
      setAiAnswer((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          workflow,
          answer: typeof workflow.result.summary === "string" ? workflow.result.summary : "Workflow completed.",
          missingData: workflow.missingSlots,
        }
      })
      setAiTrace((prev) =>
        [
          ...prev,
          {
            id: `workflow-executed-${workflow.id}-${Date.now()}`,
            status: workflow.status === "executed" ? "completed" : "warning",
            label: workflow.status === "executed" ? "Workflow executed" : "Workflow update",
            detail: typeof workflow.result.summary === "string" ? workflow.result.summary : workflow.error,
            thought: workflow.status === "executed" ? "Invoice workflow completed." : "Workflow did not complete cleanly.",
            timestamp: new Date().toISOString(),
          } satisfies AiTraceState,
        ].slice(-24),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to execute workflow."
      setAiAnswer((prev) => {
        if (!prev?.workflow || prev.workflow.id !== trimmedWorkflowId) return prev
        return {
          ...prev,
          workflow: {
            ...prev.workflow,
            status: "failed",
            error: message,
          },
        }
      })
    } finally {
      setExecutingWorkflowId((current) => (current === trimmedWorkflowId ? null : current))
    }
  }, [])

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (viewMode === "preview") {
        event.preventDefault()
        closePreview()
        return
      }
      if (viewMode === "ai") {
        // Go back to search mode
        setAiAnswer(null)
        setAiError(null)
        setIsAskingAi(false)
        setAiTrace([])
        setExecutingActionId(null)
        setExecutingWorkflowId(null)
        setShowGlow(false)
        closeAiStream()
        askRequestIdRef.current += 1
        event.preventDefault()
        return
      }
      setOpen(false)
      return
    }

    // In preview mode, Enter opens the record, Tab opens it in a new tab,
    // and ArrowLeft goes back.
    if (viewMode === "preview") {
      const previewHref = preview?.href ?? previewResult?.href ?? ""
      if (event.key === "Enter") {
        event.preventDefault()
        handleNavigate(previewHref)
        return
      }
      if (event.key === "Tab") {
        event.preventDefault()
        if (previewHref) window.open(previewHref, "_blank", "noopener,noreferrer")
        return
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        closePreview()
      }
      return
    }

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelectedIndex((prev) => Math.min(prev + 1, flatResults.length - 1))
      return
    }

    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelectedIndex((prev) => Math.max(prev - 1, -1))
      return
    }

    // ArrowRight opens the preview for the selected result.
    if (event.key === "ArrowRight" && selectedIndex >= 0 && selectedIndex < flatResults.length) {
      event.preventDefault()
      openPreview(flatResults[selectedIndex])
      return
    }

    if (event.key === "Enter") {
      event.preventDefault()

      // If a search result is selected, open its preview (the pre-step).
      if (selectedIndex >= 0 && selectedIndex < flatResults.length) {
        openPreview(flatResults[selectedIndex])
        return
      }

      // Otherwise, ask AI — or, when AI is disabled, preview the top result.
      if (query.trim()) {
        if (aiEnabled) {
          void askAi()
        } else if (flatResults.length > 0) {
          openPreview(flatResults[0])
        }
      }
    }
  }

  const handleQueryChange = (nextQuery: string) => {
    askRequestIdRef.current += 1
    closeAiStream()
    setIsAskingAi(false)
    setExecutingActionId(null)
    setExecutingWorkflowId(null)
    setQuery(nextQuery)
  }

  const clearAiAndReset = () => {
    closeAiStream()
    setAiAnswer(null)
    setAiSessionId(null)
    setAiError(null)
    setIsAskingAi(false)
    setAiTrace([])
    setExecutingActionId(null)
    setExecutingWorkflowId(null)
    setShowGlow(false)
    askRequestIdRef.current += 1
    setQuery("")
    inputRef.current?.focus()
  }

  // Scroll selected result into view
  useEffect(() => {
    if (selectedIndex < 0 || !resultsContainerRef.current) return
    const items = resultsContainerRef.current.querySelectorAll("[data-search-result]")
    items[selectedIndex]?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  return (
    <div className={className}>
      {/* Desktop trigger */}
      <div className="hidden lg:block">
        <Button
          variant="ghost"
          className="relative h-9 w-80 justify-start rounded-none border border-border/80 bg-popover/90 px-3 text-sm font-normal text-muted-foreground shadow-sm backdrop-blur transition-colors supports-[backdrop-filter]:bg-popover/80 hover:bg-accent/50 hover:text-foreground"
          onClick={() => setOpen(true)}
        >
          <Search className="mr-2 h-4 w-4" />
          <span className="truncate">{aiEnabled ? "Search or ask a question..." : "Search records..."}</span>
          <kbd className="pointer-events-none absolute right-1.5 top-1.5 hidden h-5 select-none items-center gap-1 rounded-none border border-border/60 bg-background/80 px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
            <span className="text-xs">⌘</span>K
          </kbd>
        </Button>
      </div>

      {/* Mobile trigger */}
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)}>
        <Search className="h-5 w-5" />
        <span className="sr-only">Search</span>
      </Button>

      {/* Dialog */}
      {hydrated && open && (
        <div className="fixed inset-0 z-50">
          {/* Backdrop */}
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />

          {/* Panel */}
          <motion.div
            layout
            transition={{
              layout: {
                type: "spring",
                stiffness: 360,
                damping: 34,
                mass: 0.8,
              },
            }}
            {...(showGlow ? { "data-ai-glow": "" } : {})}
            className={cn(
              "fixed left-1/2 top-[min(20vh,120px)] w-[calc(100%-2rem)] -translate-x-1/2",
              viewMode === "ai" ? "max-w-4xl" : "max-w-2xl",
              "flex flex-col overflow-hidden rounded-none border border-border/60 bg-popover shadow-2xl shadow-black/20 dark:shadow-black/50",
              "transition-[box-shadow,border-color] duration-200 ease-out",
            )}
          >
            {/* Shockwave — blurred borders expanding from panel edges */}
            <AnimatePresence>
              {shockwaveKey > 0 && (
                <motion.div
                  key={shockwaveKey}
                  className="pointer-events-none absolute inset-0 z-[-1]"
                >
                  {/* Wave 1 — tight, bright border glow */}
                  <motion.div
                    className="absolute inset-0 border-[3px] border-[oklch(0.62_0.20_215_/_0.9)]"
                    initial={{ opacity: 1, scale: 1, filter: "blur(10px)" }}
                    animate={{ opacity: 0, scale: 1.06, filter: "blur(24px)" }}
                    transition={{
                      scale: { duration: 0.85, ease: [0.22, 1, 0.36, 1] },
                      opacity: { duration: 0.85, ease: [0.4, 0, 0.2, 1], delay: 0.08 },
                      filter: { duration: 0.9, ease: [0.4, 0, 0.2, 1] },
                    }}
                  />
                  {/* Wave 2 — softer, slightly wider */}
                  <motion.div
                    className="absolute inset-0 border-2 border-[oklch(0.58_0.16_222_/_0.65)]"
                    initial={{ opacity: 0.85, scale: 1, filter: "blur(16px)" }}
                    animate={{ opacity: 0, scale: 1.1, filter: "blur(34px)" }}
                    transition={{
                      scale: { duration: 1.2, ease: [0.22, 1, 0.36, 1], delay: 0.05 },
                      opacity: { duration: 1.1, ease: [0.4, 0, 0.2, 1], delay: 0.12 },
                      filter: { duration: 1.3, ease: [0.4, 0, 0.2, 1], delay: 0.05 },
                    }}
                  />
                  {/* Wave 3 — ghost trail */}
                  <motion.div
                    className="absolute inset-0 border-[1.5px] border-[oklch(0.52_0.12_232_/_0.4)]"
                    initial={{ opacity: 0.7, scale: 1.02, filter: "blur(20px)" }}
                    animate={{ opacity: 0, scale: 1.14, filter: "blur(44px)" }}
                    transition={{
                      scale: { duration: 1.6, ease: [0.22, 1, 0.36, 1], delay: 0.1 },
                      opacity: { duration: 1.5, ease: [0.4, 0, 0.2, 1], delay: 0.2 },
                      filter: { duration: 1.7, ease: [0.4, 0, 0.2, 1], delay: 0.1 },
                    }}
                  />
                </motion.div>
              )}
            </AnimatePresence>
            {/* Input area */}
            <div
              className={cn(
                "flex items-center gap-2 border-b px-4 transition-colors",
                "bg-popover focus-within:border-foreground/30",
                viewMode === "ai" ? "border-[oklch(0.62_0.16_215_/_0.5)]" : "border-border/60",
              )}
            >
              {viewMode === "ai" ? (
                <Sparkles className="size-4 shrink-0 text-muted-foreground" />
              ) : viewMode === "preview" ? (
                <button
                  type="button"
                  onClick={closePreview}
                  aria-label="Back to results"
                  className="flex size-5 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ArrowRight className="size-4 rotate-180" />
                </button>
              ) : (
                <Search className="size-4 shrink-0 text-muted-foreground/50" />
              )}
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder={
                  viewMode === "ai" ? "Ask a follow-up..." : aiEnabled ? "Search records or ask a question..." : "Search records..."
                }
                className="h-12 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
                autoFocus
              />
              {viewMode === "ai" && (
                <button
                  type="button"
                  onClick={clearAiAndReset}
                  className="flex size-6 items-center justify-center rounded-none text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
              {viewMode === "search" && query.trim() && aiEnabled && (
                <div className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/60">
                  <CornerDownLeft className="size-3" />
                  <span>Ask AI</span>
                </div>
              )}
            </div>

            {/* Content area */}
            <div
              ref={resultsContainerRef}
              className={cn(
                "overflow-y-auto overscroll-contain",
                viewMode === "ai" ? "max-h-[60vh]" : "max-h-[min(50vh,400px)]",
              )}
            >
              {/* Idle: suggestions */}
              {viewMode === "idle" && (
                <div className="px-4 py-6">
                  {(recents.items.length > 0 || recents.queries.length > 0) && (
                    <div className="mb-4 space-y-3">
                      {recents.queries.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
                            Recent
                          </span>
                          {recents.queries.map((recentQuery) => (
                            <button
                              key={recentQuery}
                              type="button"
                              onClick={() => setQuery(recentQuery)}
                              className="rounded-none border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                            >
                              {recentQuery}
                            </button>
                          ))}
                        </div>
                      )}
                      {recents.items.length > 0 && (
                        <div className="space-y-0.5">
                          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
                            Recently viewed
                          </div>
                          {recents.items.map((item) => {
                            const ItemIcon = getIconForType(item.type)
                            return (
                              <button
                                key={`${item.type}-${item.id}`}
                                type="button"
                                onClick={() => handleNavigate(item.href)}
                                className="flex w-full items-center gap-2.5 rounded-none px-2 py-1.5 text-left transition-colors hover:bg-accent/40"
                              >
                                <ItemIcon className="size-3.5 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{item.title}</span>
                                <Badge variant="secondary" className={`${getTypeColor(item.type)} shrink-0 text-[10px]`}>
                                  {formatEntityType(item.type)}
                                </Badge>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="rounded-none border border-border/60 bg-muted/20 p-4">
                    {aiEnabled ? (
                      <>
                        <div className="mb-1.5 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                          <Sparkles className="size-3.5 text-cyan-400" />
                          Ask Naturally
                        </div>
                        <p className="text-sm text-foreground/85">
                          Ask anything about your company data in your own words. Example topics: invoices, projects, approvals, cash, schedule, RFIs, or submittals.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {SUGGESTED_AI_PROMPTS.map((prompt) => (
                            <button
                              key={prompt}
                              type="button"
                              onClick={() => {
                                setQuery(prompt)
                                void askAi(prompt)
                              }}
                              className="inline-flex items-center gap-1.5 rounded-none border border-border/60 bg-background/60 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-cyan-500/40 hover:text-cyan-500"
                            >
                              <BarChart3 className="size-3" />
                              {prompt}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="mb-1.5 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                          <Search className="size-3.5 text-muted-foreground" />
                          Search Records
                        </div>
                        <p className="text-sm text-foreground/85">
                          Find projects, contacts, companies, invoices, and more. Type a name, number, or an amount like
                          {" "}
                          <span className="font-medium">$5,000</span> or <span className="font-medium">over 10k</span>.
                        </p>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Search: live results */}
              {viewMode === "search" && (
                <div className="py-1">
                  {/* Filter chips */}
                  <div className="flex flex-wrap items-center gap-1.5 border-b border-border/40 px-4 py-2">
                    {currentProjectId && (
                      <button
                        type="button"
                        onClick={() => setScopeToProject((prev) => !prev)}
                        className={cn(
                          "rounded-none border px-2 py-0.5 text-[11px] transition-colors",
                          projectScopeActive
                            ? "border-foreground/60 bg-foreground/10 text-foreground"
                            : "border-border/60 text-muted-foreground hover:text-foreground",
                        )}
                      >
                        This project
                      </button>
                    )}
                    {FILTERABLE_TYPES.map(({ type, label }) => {
                      const active = typeFilters.includes(type)
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() =>
                            setTypeFilters((prev) =>
                              prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
                            )
                          }
                          className={cn(
                            "rounded-none border px-2 py-0.5 text-[11px] transition-colors",
                            active
                              ? "border-foreground/60 bg-foreground/10 text-foreground"
                              : "border-border/60 text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {label}
                        </button>
                      )
                    })}
                    {typeFilters.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setTypeFilters([])}
                        className="ml-auto text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Clear
                      </button>
                    )}
                  </div>

                  {isLoading && flatResults.length === 0 && (
                    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      Searching...
                    </div>
                  )}

                  {!isLoading && flatResults.length === 0 && (
                    <div className="space-y-1 py-6 text-center">
                      <p className="text-sm text-muted-foreground">No records found</p>
                      {aiEnabled && (
                        <p className="text-xs text-muted-foreground/60">
                          Press <kbd className="rounded-none border border-border/60 bg-muted/50 px-1 py-0.5 font-mono text-[10px]">Enter</kbd> to ask AI instead
                        </p>
                      )}
                    </div>
                  )}

                  {flatResults.length > 0 &&
                    Object.entries(groupedSearchResults).map(([groupName, groupItems]) => (
                      <div key={groupName}>
                        <div className="px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
                          {groupName}
                        </div>
                        {groupItems.map((result) => {
                          const globalIndex = flatResults.findIndex((item) => item.type === result.type && item.id === result.id)
                          const isSelected = globalIndex === selectedIndex
                          const IconComponent = result.icon ?? getIconForType(result.type)
                          const { amount, status, statusTone, rest } = splitSubtitle(result.subtitle)
                          const statusStyle = statusTone ? STATUS_TONE_STYLES[statusTone] : null
                          return (
                            <button
                              key={`${result.type}-${result.id}`}
                              type="button"
                              data-search-result
                              onClick={(event) => {
                                // ⌘/Ctrl-click jumps straight to the record; a
                                // plain click opens the morphing preview first.
                                if (event.metaKey || event.ctrlKey) {
                                  handleNavigate(result.href)
                                } else {
                                  openPreview(result)
                                }
                              }}
                              onMouseEnter={() => setSelectedIndex(globalIndex)}
                              className={cn(
                                "group flex w-full items-center gap-3 px-4 py-2 text-left transition-colors",
                                isSelected ? "bg-accent/80" : "hover:bg-accent/40",
                              )}
                            >
                              <div className="flex size-7 shrink-0 items-center justify-center rounded-none border border-border/50 bg-muted/30">
                                <IconComponent className="size-3.5 text-muted-foreground" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm text-foreground">{highlightMatch(result.title, query)}</div>
                                {(status || rest) && (
                                  <div className="flex items-center gap-1.5 truncate text-xs">
                                    {status && statusStyle && (
                                      <span className={cn("shrink-0 font-medium", statusStyle.text)}>{status}</span>
                                    )}
                                    {status && rest && <span className="text-muted-foreground/40">·</span>}
                                    {rest && <span className="truncate text-muted-foreground">{highlightMatch(rest, query)}</span>}
                                  </div>
                                )}
                              </div>
                              {amount && (
                                <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">{amount}</span>
                              )}
                              {result.project_name && (
                                <span className="hidden shrink-0 text-[11px] text-muted-foreground/50 sm:block">
                                  {result.project_name}
                                </span>
                              )}
                              <Badge variant="secondary" className={`${getTypeColor(result.type)} shrink-0 text-[10px]`}>
                                {formatEntityType(result.type)}
                              </Badge>
                              {result.updated_at && (
                                <span className="hidden shrink-0 text-[10px] text-muted-foreground/40 sm:block">
                                  {formatRelativeTime(result.updated_at)}
                                </span>
                              )}
                              <ArrowRight className="size-3 shrink-0 text-muted-foreground/30 transition-colors group-hover:text-muted-foreground/70" />
                            </button>
                          )
                        })}
                      </div>
                    ))}

                  {/* See all results */}
                  {flatResults.length > 0 && (
                    <div className="border-t border-border/40 px-4 py-2">
                      <button
                        type="button"
                        onClick={() => {
                          const sp = new URLSearchParams({ q: query.trim() })
                          if (typeFilters.length > 0) sp.set("types", [...typeFilters].sort().join(","))
                          if (projectScopeActive && currentProjectId) sp.set("projectId", currentProjectId)
                          handleNavigate(`/search?${sp.toString()}`)
                        }}
                        className="flex w-full items-center gap-2 rounded-none px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                      >
                        <Search className="size-3" />
                        <span>See all results</span>
                        <ArrowRight className="ml-auto size-3" />
                      </button>
                    </div>
                  )}

                  {/* AI suggestion at bottom of search results */}
                  {flatResults.length > 0 && aiEnabled && (
                    <div className="border-t border-border/40 px-4 py-2">
                      <button
                        type="button"
                        onClick={() => void askAi()}
                        className="flex w-full items-center gap-2 rounded-none px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-cyan-500/10 hover:text-cyan-500"
                      >
                        <Sparkles className="size-3" />
                        <span>Ask AI about "{query.trim()}"</span>
                        <CornerDownLeft className="ml-auto size-3" />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Preview mode: morphed entity peek */}
              {viewMode === "preview" && previewResult && (
                <EntityPreviewPanel
                  result={previewResult}
                  preview={preview}
                  isLoading={isPreviewLoading}
                  error={previewError}
                />
              )}

              {/* AI mode: loading or response */}
              {viewMode === "ai" && (
                <>
                  {isAskingAi && <AiLoadingIndicator trace={aiTrace} />}
                  {!isAskingAi && (aiAnswer || aiError) && (
                    <AiResponsePanel
                      aiAnswer={aiAnswer!}
                      aiError={aiError}
                      submittedQuery={submittedQuery}
                      onRetry={() => void askAi(submittedQuery)}
                      onNavigate={handleNavigate}
                      onExecuteAction={(actionId) => void executeProposedAction(actionId)}
                      onRespondToWorkflow={(workflowId, value) => void respondToWorkflow(workflowId, value)}
                      onExecuteWorkflow={(workflowId) => void executeWorkflow(workflowId)}
                      onCancel={clearAiAndReset}
                      executingActionId={executingActionId}
                      executingWorkflowId={executingWorkflowId}
                    />
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-border/40 bg-muted/20 px-4 py-1.5">
              <div
                className={cn(
                  "flex items-center gap-3 text-[10px] text-muted-foreground/50",
                  viewMode === "preview" && "ml-auto",
                )}
              >
                {viewMode === "ai" ? (
                  <>
                    <span className="flex items-center gap-1">
                      <kbd className="rounded-none border border-border/40 px-1 py-0.5 font-mono">Esc</kbd>
                      Back
                    </span>
                  </>
                ) : viewMode === "preview" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => handleNavigate(preview?.href ?? previewResult?.href ?? "")}
                      className="flex items-center gap-1 text-blue-600 transition-opacity hover:opacity-70 dark:text-blue-400"
                    >
                      <kbd className="rounded-none border border-border/40 px-1 py-0.5 font-mono">↵</kbd>
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const href = preview?.href ?? previewResult?.href ?? ""
                        if (href) window.open(href, "_blank", "noopener,noreferrer")
                      }}
                      className="flex items-center gap-1 text-violet-600 transition-opacity hover:opacity-70 dark:text-violet-400"
                    >
                      <kbd className="rounded-none border border-border/40 px-1 py-0.5 font-mono">Tab</kbd>
                      Open in new tab
                    </button>
                    <button
                      type="button"
                      onClick={closePreview}
                      className="flex items-center gap-1 transition-colors hover:text-foreground"
                    >
                      <kbd className="rounded-none border border-border/40 px-1 py-0.5 font-mono">Esc</kbd>
                      Back
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex items-center gap-1">
                      <kbd className="rounded-none border border-border/40 px-1 py-0.5 font-mono">↑↓</kbd>
                      Navigate
                    </span>
                    <span className="flex items-center gap-1">
                      <kbd className="rounded-none border border-border/40 px-1 py-0.5 font-mono">↵</kbd>
                      {selectedIndex >= 0 ? "Preview" : aiEnabled ? "Ask AI" : "Preview"}
                    </span>
                    <span className="flex items-center gap-1">
                      <kbd className="rounded-none border border-border/40 px-1 py-0.5 font-mono">Esc</kbd>
                      Close
                    </span>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  )
}
