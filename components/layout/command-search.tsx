"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { useRouter } from "next/navigation"
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
  X,
  type LucideIcon,
} from "@/components/icons"

import { AnimatePresence, motion } from "framer-motion"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
  "conversation",
  "message",
  "rfi",
  "submittal",
  "drawing_set",
  "drawing_sheet",
  "daily_log",
  "punch_item",
  "schedule_item",
  "photo",
  "portal_access",
] as const

type SearchType = (typeof SEARCH_TYPES)[number]

const SEARCH_TYPE_SET = new Set<string>(SEARCH_TYPES)
const SEARCH_CACHE_TTL_MS = 20_000
const MIN_LIVE_SEARCH_CHARS = 2

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
    kind: "table" | "chart"
    datasetId: string
    title: string
    table?: {
      columns: string[]
      rows: Array<Array<string | number | null>>
    }
    chart?: {
      type: "bar"
      points: Array<{ label: string; value: number }>
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

function toAiArtifact(raw: unknown): AiAnswerState["artifact"] | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  if (
    (value.kind !== "table" && value.kind !== "chart") ||
    typeof value.datasetId !== "string" ||
    typeof value.title !== "string"
  ) {
    return undefined
  }

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
          if (chartValue.type !== "bar") return undefined
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

          return {
            type: "bar" as const,
            points,
            valuePrefix: typeof chartValue.valuePrefix === "string" ? chartValue.valuePrefix : undefined,
            valueSuffix: typeof chartValue.valueSuffix === "string" ? chartValue.valueSuffix : undefined,
          }
        })()
      : undefined

  return {
    kind: value.kind,
    datasetId: value.datasetId,
    title: value.title,
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
    case "conversation":
    case "message":
      return MessageSquare
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
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300"
    case "conversation":
    case "message":
      return "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300"
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

function formatArtifactValue(value: string | number | null | undefined, prefix?: string, suffix?: string) {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "number") {
    const text = Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    return `${prefix ?? ""}${text}${suffix ?? ""}`
  }
  return value
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

function AiResponsePanel({
  aiAnswer,
  aiError,
  submittedQuery,
  onRetry,
  onNavigate,
  onExecuteAction,
  executingActionId,
}: {
  aiAnswer: AiAnswerState
  aiError: string | null
  submittedQuery: string
  onRetry: () => void
  onNavigate: (href: string) => void
  onExecuteAction: (actionId: string) => void
  executingActionId: string | null
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
              <div className="space-y-1 px-3 py-2.5">
                {(() => {
                  const max = aiAnswer.artifact?.chart?.points.reduce((acc, point) => Math.max(acc, point.value), 0) ?? 0
                  return aiAnswer.artifact!.chart!.points.map((point) => {
                    const width = max > 0 ? Math.max(4, Math.round((point.value / max) * 100)) : 0
                    return (
                      <div key={`${aiAnswer.artifact?.datasetId}-${point.label}`} className="grid grid-cols-[100px_1fr_auto] items-center gap-3">
                        <div className="truncate text-right text-[11px] text-muted-foreground">{point.label}</div>
                        <div className="h-5 w-full overflow-hidden rounded-none bg-muted/40">
                          <div className="h-full rounded-none bg-foreground/30 transition-all duration-500" style={{ width: `${width}%` }} />
                        </div>
                        <div className="min-w-[60px] text-right text-[11px] font-medium tabular-nums text-foreground">
                          {formatArtifactValue(
                            point.value,
                            aiAnswer.artifact?.chart?.valuePrefix,
                            aiAnswer.artifact?.chart?.valueSuffix,
                          )}
                        </div>
                      </div>
                    )
                  })
                })()}
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

// ---------- Main Component ----------

type ViewMode = "idle" | "search" | "ai"
export function CommandSearch({ className }: CommandSearchProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isAskingAi, setIsAskingAi] = useState(false)
  const [aiAnswer, setAiAnswer] = useState<AiAnswerState | null>(null)
  const [aiSessionId, setAiSessionId] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiTrace, setAiTrace] = useState<AiTraceState[]>([])
  const [executingActionId, setExecutingActionId] = useState<string | null>(null)
  const [submittedQuery, setSubmittedQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [showGlow, setShowGlow] = useState(false)
  const [shockwaveKey, setShockwaveKey] = useState(0)
  const hydrated = useHydrated()
  const router = useRouter()
  const askRequestIdRef = useRef(0)
  const aiAbortRef = useRef<AbortController | null>(null)
  const searchAbortRef = useRef<AbortController | null>(null)
  const searchCacheRef = useRef<Map<string, { expiresAt: number; results: SearchResult[] }>>(new Map())
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsContainerRef = useRef<HTMLDivElement>(null)

  const viewMode: ViewMode = isAskingAi || aiAnswer || aiError ? "ai" : query.trim() ? "search" : "idle"

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

      const cacheKey = trimmedQuery.toLowerCase()
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
  }, [])

  const askAi = useCallback(
    async (overrideQuery?: string) => {
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
    [aiSessionId, closeAiStream, query],
  )

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
      setSubmittedQuery("")
      setSelectedIndex(-1)
      setShowGlow(false)
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

  // Clear AI when query changes
  useEffect(() => {
    setAiAnswer(null)
    setAiError(null)
    setAiTrace([])
    setExecutingActionId(null)
    setSelectedIndex(-1)
  }, [query])

  const handleNavigate = useCallback(
    (href: string) => {
      setOpen(false)
      router.push(href)
    },
    [router],
  )

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

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (viewMode === "ai") {
        // Go back to search mode
        setAiAnswer(null)
        setAiError(null)
        setIsAskingAi(false)
        setAiTrace([])
        setExecutingActionId(null)
        setShowGlow(false)
        closeAiStream()
        askRequestIdRef.current += 1
        event.preventDefault()
        return
      }
      setOpen(false)
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

    if (event.key === "Enter") {
      event.preventDefault()

      // If a search result is selected, navigate to it
      if (selectedIndex >= 0 && selectedIndex < flatResults.length) {
        handleNavigate(flatResults[selectedIndex].href)
        return
      }

      // Otherwise, ask AI
      if (query.trim()) {
        void askAi()
      }
    }
  }

  const handleQueryChange = (nextQuery: string) => {
    askRequestIdRef.current += 1
    closeAiStream()
    setIsAskingAi(false)
    setExecutingActionId(null)
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
          <span className="truncate">Search or ask a question...</span>
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
                "flex items-center gap-2 border-b px-4",
                "border-border/60 bg-popover",
              )}
            >
              {viewMode === "ai" ? (
                <Sparkles className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <Search className="size-4 shrink-0 text-muted-foreground/50" />
              )}
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder={viewMode === "ai" ? "Ask a follow-up..." : "Search records or ask a question..."}
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
              {viewMode !== "ai" && query.trim() && (
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
                  <div className="rounded-none border border-border/60 bg-muted/20 p-4">
                    <div className="mb-1.5 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                      <Sparkles className="size-3.5 text-cyan-400" />
                      Ask Naturally
                    </div>
                    <p className="text-sm text-foreground/85">
                      Ask anything about your company data in your own words. Example topics: invoices, projects, approvals, cash, schedule, RFIs, or submittals.
                    </p>
                  </div>
                </div>
              )}

              {/* Search: live results */}
              {viewMode === "search" && (
                <div className="py-1">
                  {isLoading && flatResults.length === 0 && (
                    <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      Searching...
                    </div>
                  )}

                  {!isLoading && flatResults.length === 0 && (
                    <div className="space-y-1 py-6 text-center">
                      <p className="text-sm text-muted-foreground">No records found</p>
                      <p className="text-xs text-muted-foreground/60">
                        Press <kbd className="rounded-none border border-border/60 bg-muted/50 px-1 py-0.5 font-mono text-[10px]">Enter</kbd> to ask AI instead
                      </p>
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
                          return (
                            <button
                              key={`${result.type}-${result.id}`}
                              type="button"
                              data-search-result
                              onClick={() => handleNavigate(result.href)}
                              onMouseEnter={() => setSelectedIndex(globalIndex)}
                              className={cn(
                                "flex w-full items-center gap-3 px-4 py-2 text-left transition-colors",
                                isSelected ? "bg-accent/80" : "hover:bg-accent/40",
                              )}
                            >
                              <div className="flex size-7 shrink-0 items-center justify-center rounded-none border border-border/50 bg-muted/30">
                                <IconComponent className="size-3.5 text-muted-foreground" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm text-foreground">{result.title}</div>
                                {result.subtitle && (
                                  <div className="truncate text-xs text-muted-foreground">{result.subtitle}</div>
                                )}
                              </div>
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
                            </button>
                          )
                        })}
                      </div>
                    ))}

                  {/* AI suggestion at bottom of search results */}
                  {flatResults.length > 0 && (
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
                      executingActionId={executingActionId}
                    />
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-border/40 bg-muted/20 px-4 py-1.5">
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground/50">
                {viewMode === "ai" ? (
                  <>
                    <span className="flex items-center gap-1">
                      <kbd className="rounded-none border border-border/40 px-1 py-0.5 font-mono">Esc</kbd>
                      Back
                    </span>
                  </>
                ) : (
                  <>
                    <span className="flex items-center gap-1">
                      <kbd className="rounded-none border border-border/40 px-1 py-0.5 font-mono">↑↓</kbd>
                      Navigate
                    </span>
                    <span className="flex items-center gap-1">
                      <kbd className="rounded-none border border-border/40 px-1 py-0.5 font-mono">↵</kbd>
                      {selectedIndex >= 0 ? "Open" : "Ask AI"}
                    </span>
                    <span className="flex items-center gap-1">
                      <kbd className="rounded-none border border-border/40 px-1 py-0.5 font-mono">Esc</kbd>
                      Close
                    </span>
                  </>
                )}
              </div>
              {viewMode === "ai" && <div />}
            </div>
          </motion.div>
        </div>
      )}
    </div>
  )
}
