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
  type LucideIcon,
} from "@/components/icons"

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
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
  generatedAt: string
  mode: "llm" | "fallback"
  provider?: "openai" | "anthropic" | "google"
  model?: string
  configSource?: "org" | "platform" | "env" | "default"
}

type CommandMode = "search" | "ask"

interface CommandSearchProps {
  className?: string
}

const QUICK_JUMPS = [
  {
    id: "quick-projects",
    title: "All projects",
    subtitle: "Browse and jump to any project",
    href: "/projects",
    icon: Building2,
  },
  {
    id: "quick-files",
    title: "Files",
    subtitle: "Open your document workspace",
    href: "/files",
    icon: FolderOpen,
  },
  {
    id: "quick-tasks",
    title: "Tasks",
    subtitle: "Review open action items",
    href: "/tasks",
    icon: CheckSquare,
  },
  {
    id: "quick-messages",
    title: "Messages",
    subtitle: "Open your inbox",
    href: "/messages",
    icon: MessageSquare,
  },
]

const SEARCH_HINTS = [
  {
    id: "hint-invoice",
    title: "Find invoices",
    subtitle: 'Try "invoice 1021" or client name',
    query: "invoice ",
    icon: Receipt,
  },
  {
    id: "hint-drawing",
    title: "Find drawings",
    subtitle: 'Try "sheet A1" or set name',
    query: "drawing ",
    icon: Layers,
  },
  {
    id: "hint-rfi",
    title: "Find RFIs/Submittals",
    subtitle: 'Try "rfi", "submittal", or spec section',
    query: "rfi ",
    icon: AlertTriangle,
  },
]

const AI_PROMPTS = [
  {
    id: "ai-overdue",
    title: "What work is overdue?",
    subtitle: "Get a quick triage from tasks and logs",
    query: "What work is overdue right now?",
    icon: CheckSquare,
  },
  {
    id: "ai-finance",
    title: "Summarize financial risk",
    subtitle: "Surface invoices, commitments, and change activity",
    query: "Summarize financial risk across active projects",
    icon: DollarSign,
  },
  {
    id: "ai-comms",
    title: "What needs a response?",
    subtitle: "Find RFIs and submittals that need attention",
    query: "What RFIs or submittals need a response?",
    icon: MessageSquare,
  },
]

const AI_CONFIG_SOURCE_LABELS: Record<NonNullable<AiAnswerState["configSource"]>, string> = {
  org: "Org override",
  platform: "Arc default",
  env: "Env default",
  default: "Built-in default",
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

  const state: AiAnswerState = {
    answer: value.answer,
    citations,
    relatedResults,
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : new Date().toISOString(),
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

export function CommandSearch({ className }: CommandSearchProps) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<CommandMode>("search")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isAskingAi, setIsAskingAi] = useState(false)
  const [aiAnswer, setAiAnswer] = useState<AiAnswerState | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const hydrated = useHydrated()
  const router = useRouter()
  const askRequestIdRef = useRef(0)

  const searchItems = useCallback(async (searchQuery: string): Promise<SearchResult[]> => {
    if (!searchQuery.trim()) return []

    try {
      const { searchAction } = await import("@/app/actions/dashboard")
      const rawResults = await searchAction(searchQuery)
      return rawResults
        .map(toSearchResult)
        .filter((result): result is SearchResult => Boolean(result))
        .map((result) => ({
          ...result,
          icon: getIconForType(result.type),
        }))
    } catch (error) {
      console.error("Search failed:", error)
      return []
    }
  }, [])

  const askAi = useCallback(
    async (overrideQuery?: string) => {
      const prompt = (overrideQuery ?? query).trim()
      if (!prompt) return

      const requestId = ++askRequestIdRef.current
      setIsAskingAi(true)
      setAiError(null)

      try {
        const { askAiSearchAction } = await import("@/app/actions/dashboard")
        const rawResponse = await askAiSearchAction(prompt, { limit: 20 })
        if (askRequestIdRef.current !== requestId) return

        const normalized = toAiAnswerState(rawResponse)
        if (!normalized) {
          setAiError("The AI response format was invalid. Please try again.")
          setAiAnswer(null)
          return
        }

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
      } catch (error) {
        if (askRequestIdRef.current !== requestId) return
        console.error("AI search failed:", error)
        setAiAnswer(null)
        setAiError("I couldn't answer right now. Please try again.")
      } finally {
        if (askRequestIdRef.current === requestId) {
          setIsAskingAi(false)
        }
      }
    },
    [query],
  )

  // Handle keyboard shortcuts.
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

  // Reset dialog state on close.
  useEffect(() => {
    if (!open) {
      askRequestIdRef.current += 1
      setMode("search")
      setQuery("")
      setResults([])
      setIsLoading(false)
      setIsAskingAi(false)
      setAiAnswer(null)
      setAiError(null)
    }
  }, [open])

  // Live keyword search mode.
  useEffect(() => {
    if (mode !== "search") return

    let isCancelled = false
    const search = async () => {
      if (!query.trim()) {
        setResults([])
        return
      }

      setIsLoading(true)
      try {
        const searchResults = await searchItems(query)
        if (!isCancelled) {
          setResults(searchResults)
        }
      } catch (error) {
        if (!isCancelled) {
          console.error("Search failed:", error)
          setResults([])
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false)
        }
      }
    }

    const debounceTimer = setTimeout(search, 150)
    return () => {
      isCancelled = true
      clearTimeout(debounceTimer)
    }
  }, [mode, query, searchItems])

  // Reset mode-specific state when switching tabs.
  useEffect(() => {
    if (mode === "search") {
      setAiAnswer(null)
      setAiError(null)
      setIsAskingAi(false)
      askRequestIdRef.current += 1
      return
    }

    setResults([])
    setIsLoading(false)
  }, [mode])

  // New AI prompt should clear old response until resubmitted.
  useEffect(() => {
    if (mode === "ask") {
      setAiAnswer(null)
      setAiError(null)
    }
  }, [mode, query])

  const handleSelect = (result: SearchResult) => {
    setOpen(false)
    setQuery("")
    router.push(result.href)
  }

  const handleCitationSelect = (citation: AiCitation) => {
    setOpen(false)
    setQuery("")
    router.push(citation.href)
  }

  const handleQuickJump = (href: string) => {
    setOpen(false)
    setQuery("")
    router.push(href)
  }

  const groupResults = useCallback((items: SearchResult[]) => {
    const grouped: Record<string, SearchResult[]> = {}

    items.forEach((result) => {
      const typeLabel = `${formatEntityType(result.type)}s`
      if (!grouped[typeLabel]) {
        grouped[typeLabel] = []
      }
      grouped[typeLabel].push(result)
    })

    return grouped
  }, [])

  const hasQuery = query.trim().length > 0
  const groupedSearchResults = useMemo(() => groupResults(results), [groupResults, results])
  const groupedAiRelatedResults = useMemo(
    () => groupResults(aiAnswer?.relatedResults ?? []),
    [aiAnswer?.relatedResults, groupResults],
  )

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") {
      event.preventDefault()
      setMode((prev) => (prev === "search" ? "ask" : "search"))
      return
    }
    if (mode === "ask" && event.key === "Enter") {
      event.preventDefault()
      void askAi()
    }
  }

  const renderResultItem = (result: SearchResult) => {
    const IconComponent = result.icon ?? getIconForType(result.type)
    return (
      <CommandItem
        key={`${result.type}-${result.id}`}
        value={[result.title, result.subtitle, result.description, result.project_name, formatEntityType(result.type)]
          .filter(Boolean)
          .join(" ")}
        onSelect={() => handleSelect(result)}
        className="flex items-start gap-3 rounded-none border border-transparent px-2.5 py-2.5 data-[selected=true]:border-primary/30 data-[selected=true]:bg-primary/5"
      >
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-none border border-border/70 bg-background/70">
          <IconComponent className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="truncate font-medium">{result.title}</div>
          {result.subtitle && <div className="truncate text-xs text-muted-foreground">{result.subtitle}</div>}
          {result.description && <div className="line-clamp-2 truncate text-xs text-muted-foreground">{result.description}</div>}
          {result.project_name && <div className="truncate text-xs text-muted-foreground/70">in {result.project_name}</div>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant="secondary" className={`${getTypeColor(result.type)} text-xs`}>
            {formatEntityType(result.type)}
          </Badge>
          {result.updated_at && (
            <div className="text-xs text-muted-foreground">{formatRelativeTime(result.updated_at)}</div>
          )}
        </div>
      </CommandItem>
    )
  }

  return (
    <div className={className}>
      {/* Desktop trigger */}
      <div className="hidden lg:block">
        <Button
          variant="ghost"
          className="relative h-9 w-80 justify-start rounded-none border border-border/80 bg-popover/90 px-3 text-sm font-normal text-muted-foreground shadow-sm backdrop-blur supports-[backdrop-filter]:bg-popover/80 transition-colors hover:bg-accent/50 hover:text-foreground"
          onClick={() => setOpen(true)}
        >
          <Search className="mr-2 h-4 w-4" />
          <span className="truncate">Search or ask AI about your org...</span>
          <span className="absolute right-10 top-1.5 flex items-center gap-1 rounded-none border border-cyan-500/30 bg-cyan-950/20 px-1.5 py-0.5 text-[10px] font-medium text-cyan-400">
            <Sparkles className="h-3 w-3" />
            AI
          </span>
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

      {hydrated && (
        <CommandDialog
          open={open}
          onOpenChange={setOpen}
          showCloseButton={false}
          className={cn(
            "max-w-3xl rounded-none bg-popover/95 p-0 shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-popover/90",
            mode === "ask" && "ai-glow-active",
          )}
          commandProps={{
            shouldFilter: false,
            className:
              "min-h-[460px] [&_[data-slot=command-input-wrapper]]:h-12 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide",
          }}
        >
          <CommandInput
            placeholder={mode === "search" ? "Search projects, contacts, invoices, drawings..." : "Ask anything about your org data..."}
            value={query}
            onValueChange={setQuery}
            onKeyDown={handleInputKeyDown}
            wrapperClassName={cn(
              "transition-colors duration-500",
              mode === "ask" && "border-cyan-500/20",
            )}
            icon={
              mode === "ask" ? (
                <Sparkles className="size-4 shrink-0 text-cyan-400" />
              ) : undefined
            }
          />

          <div className={cn(
            "flex items-center justify-between border-b px-2.5 py-2 transition-colors duration-500",
            mode === "ask" ? "border-cyan-500/20 bg-cyan-950/10" : "border-border/60",
          )}>
            <div className="inline-flex rounded-none border border-border/70 bg-background/60 p-0.5">
              <button
                type="button"
                onClick={() => setMode("search")}
                className={cn(
                  "rounded-none px-2.5 py-1 text-xs font-medium transition-all duration-300",
                  mode === "search" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                Search
              </button>
              <button
                type="button"
                onClick={() => setMode("ask")}
                className={cn(
                  "rounded-none px-2.5 py-1 text-xs font-medium transition-all duration-300",
                  mode === "ask" ? "bg-gradient-to-r from-cyan-500 to-blue-500 text-white" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Sparkles className={cn("mr-1 inline-block h-3 w-3 transition-transform duration-300", mode === "ask" && "animate-pulse")} />
                Ask AI
              </button>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{mode === "search" ? "Live search" : "Press Enter to ask"}</span>
              <kbd className="rounded-none border border-border/60 bg-background/80 px-1.5 py-0.5 font-mono text-[10px]">Tab</kbd>
              <span>to switch</span>
            </div>
          </div>

          {mode === "ask" && hasQuery && (
            <div className="border-b border-cyan-500/15 px-2.5 py-2.5">
              <div className="flex items-center justify-between gap-3 rounded-none border border-cyan-500/20 bg-cyan-950/10 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-cyan-400/80">
                    <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
                    AI Search
                  </div>
                  <p className="truncate text-sm text-foreground">
                    {isAskingAi ? "Analyzing org records..." : `Ask: "${query.trim()}"`}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 rounded-none bg-gradient-to-r from-cyan-500 to-blue-500 text-white hover:from-cyan-600 hover:to-blue-600"
                  onClick={() => void askAi()}
                  disabled={isAskingAi}
                >
                  {isAskingAi ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      Thinking
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      Ask AI
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          <CommandList className="max-h-[72vh]">
            {mode === "search" && (
              <>
                {isLoading && <div className="py-6 text-center text-sm text-muted-foreground">Searching...</div>}
                {!isLoading && hasQuery && results.length === 0 && <CommandEmpty>No results found.</CommandEmpty>}

                {!isLoading && !hasQuery && (
                  <>
                    <CommandGroup heading="Quick jump">
                      {QUICK_JUMPS.map((item) => {
                        const IconComponent = item.icon
                        return (
                          <CommandItem
                            key={item.id}
                            value={`${item.title} ${item.subtitle}`}
                            onSelect={() => handleQuickJump(item.href)}
                            className="group gap-3 rounded-none border border-transparent px-2.5 py-2.5 data-[selected=true]:border-primary/30 data-[selected=true]:bg-primary/5"
                          >
                            <div className="flex size-8 shrink-0 items-center justify-center rounded-none border border-border/70 bg-background/70">
                              <IconComponent className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-foreground">{item.title}</div>
                              <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                            </div>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                    <CommandSeparator />
                    <CommandGroup heading="Search tips">
                      {SEARCH_HINTS.map((item) => {
                        const IconComponent = item.icon
                        return (
                          <CommandItem
                            key={item.id}
                            value={`${item.title} ${item.subtitle}`}
                            onSelect={() => setQuery(item.query)}
                            className="gap-3 rounded-none px-2.5 py-2.5"
                          >
                            <IconComponent className="h-4 w-4 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{item.title}</div>
                              <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                            </div>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  </>
                )}

                {!isLoading &&
                  hasQuery &&
                  results.length > 0 &&
                  Object.entries(groupedSearchResults).map(([groupName, groupItems]) => (
                    <CommandGroup key={groupName} heading={groupName}>
                      {groupItems.map(renderResultItem)}
                    </CommandGroup>
                  ))}
              </>
            )}

            {mode === "ask" && (
              <>
                {!hasQuery && (
                  <>
                    <CommandGroup heading="Ask AI">
                      {AI_PROMPTS.map((prompt) => {
                        const IconComponent = prompt.icon
                        return (
                          <CommandItem
                            key={prompt.id}
                            value={`${prompt.title} ${prompt.subtitle}`}
                            onSelect={() => {
                              setQuery(prompt.query)
                              void askAi(prompt.query)
                            }}
                            className="group gap-3 rounded-none border border-transparent px-2.5 py-2.5 data-[selected=true]:border-cyan-500/30 data-[selected=true]:bg-cyan-500/10"
                          >
                            <div className="flex size-8 shrink-0 items-center justify-center rounded-none border border-border/70 bg-background/70">
                              <IconComponent className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-foreground">{prompt.title}</div>
                              <div className="truncate text-xs text-muted-foreground">{prompt.subtitle}</div>
                            </div>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                    <CommandSeparator />
                    <CommandGroup heading="Quick jump">
                      {QUICK_JUMPS.map((item) => {
                        const IconComponent = item.icon
                        return (
                          <CommandItem
                            key={`${item.id}-ai`}
                            value={`${item.title} ${item.subtitle}`}
                            onSelect={() => handleQuickJump(item.href)}
                            className="gap-3 rounded-none px-2.5 py-2.5"
                          >
                            <IconComponent className="h-4 w-4 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{item.title}</div>
                              <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                            </div>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  </>
                )}

                {hasQuery && (
                  <CommandGroup heading="Answer">
                    <div className="px-2.5 pb-2">
                      <div className="rounded-none border border-border/70 bg-background/60 p-3">
                        {isAskingAi && (
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Generating answer from org data...
                          </div>
                        )}
                        {!isAskingAi && aiError && (
                          <div className="space-y-2">
                            <p className="text-sm text-destructive">{aiError}</p>
                            <Button type="button" size="sm" variant="outline" className="h-8 rounded-none" onClick={() => void askAi()}>
                              Retry
                            </Button>
                          </div>
                        )}
                        {!isAskingAi && !aiError && aiAnswer && (
                          <div className="space-y-2">
                            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{aiAnswer.answer}</p>
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                              <span className="rounded-none border border-border/70 px-1.5 py-0.5">
                                {aiAnswer.mode === "llm" ? "AI synthesis" : "Deterministic summary"}
                              </span>
                              {aiAnswer.provider && (
                                <span className="rounded-none border border-border/70 px-1.5 py-0.5 capitalize">
                                  {aiAnswer.provider}
                                </span>
                              )}
                              {aiAnswer.model && (
                                <span className="rounded-none border border-border/70 px-1.5 py-0.5">{aiAnswer.model}</span>
                              )}
                              {aiAnswer.configSource && (
                                <span className="rounded-none border border-border/70 px-1.5 py-0.5">
                                  {AI_CONFIG_SOURCE_LABELS[aiAnswer.configSource]}
                                </span>
                              )}
                              <span>{formatRelativeTime(aiAnswer.generatedAt) || "just now"}</span>
                            </div>
                          </div>
                        )}
                        {!isAskingAi && !aiError && !aiAnswer && (
                          <p className="text-sm text-muted-foreground">Press Enter to ask. I’ll answer from records in your current org.</p>
                        )}
                      </div>
                    </div>
                  </CommandGroup>
                )}

                {hasQuery && aiAnswer && aiAnswer.citations.length > 0 && (
                  <CommandGroup heading="Sources">
                    {aiAnswer.citations.map((citation) => {
                      const IconComponent = citation.icon ?? getIconForType(citation.type)
                      return (
                        <CommandItem
                          key={`${citation.sourceId}-${citation.id}`}
                          value={`${citation.title} ${citation.subtitle ?? ""} ${citation.projectName ?? ""}`}
                          onSelect={() => handleCitationSelect(citation)}
                          className="flex items-start gap-3 rounded-none border border-transparent px-2.5 py-2.5 data-[selected=true]:border-cyan-500/30 data-[selected=true]:bg-cyan-500/10"
                        >
                          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-none border border-border/70 bg-background/70">
                            <IconComponent className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <div className="truncate font-medium">{citation.title}</div>
                            {citation.subtitle && <div className="truncate text-xs text-muted-foreground">{citation.subtitle}</div>}
                            {citation.projectName && (
                              <div className="truncate text-xs text-muted-foreground/70">in {citation.projectName}</div>
                            )}
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <Badge variant="secondary" className={`${getTypeColor(citation.type)} text-xs`}>
                              {citation.sourceId}
                            </Badge>
                          </div>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                )}

                {hasQuery &&
                  aiAnswer &&
                  aiAnswer.relatedResults.length > 0 &&
                  Object.entries(groupedAiRelatedResults).map(([groupName, groupItems]) => (
                    <CommandGroup key={`ai-${groupName}`} heading={`Related ${groupName}`}>
                      {groupItems.map(renderResultItem)}
                    </CommandGroup>
                  ))}
              </>
            )}
          </CommandList>
        </CommandDialog>
      )}
    </div>
  )
}
