"use client"

import { useCallback, useEffect, useState } from "react"
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
  Wrench,
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
} from "@/components/icons"

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

interface SearchResult {
  id: string
  type: "project" | "task" | "file" | "contact" | "company" | "invoice" | "payment" | "budget" | "estimate" | "commitment" | "change_order" | "contract" | "proposal" | "conversation" | "message" | "rfi" | "submittal" | "drawing_set" | "drawing_sheet" | "daily_log" | "punch_item" | "schedule_item" | "photo" | "portal_access"
  title: string
  subtitle?: string
  description?: string
  href: string
  project_id?: string
  project_name?: string
  created_at?: string
  updated_at?: string
  icon?: any
}

interface CommandSearchProps {
  className?: string
}

export function CommandSearch({ className }: CommandSearchProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const router = useRouter()

  // Search function using server action
  const searchItems = useCallback(async (searchQuery: string): Promise<SearchResult[]> => {
    if (!searchQuery.trim()) return []

    try {
      // Import server action
      const { searchAction } = await import("@/app/actions/dashboard")

      // Call server action
      const rawResults = await searchAction(searchQuery)

      // Transform results to include icons
      return rawResults.map(result => ({
        ...result,
        icon: getIconForType(result.type),
      }))
    } catch (error) {
      console.error("Search failed:", error)
      return []
    }
  }, [])

  // Get icon component for entity type
  const getIconForType = (type: SearchResult["type"]) => {
    switch (type) {
      case "project": return Building2
      case "task": return CheckSquare
      case "file": return FileText
      case "contact": return User
      case "company": return Users
      case "invoice": return Receipt
      case "payment": return CreditCard
      case "budget": return DollarSign
      case "estimate": return FileSpreadsheet
      case "commitment": return Briefcase
      case "change_order": return CheckCircle
      case "contract": return FileText
      case "proposal": return CheckCircle
      case "conversation": return MessageSquare
      case "message": return MessageSquare
      case "rfi": return AlertTriangle
      case "submittal": return CheckCircle
      case "drawing_set": return Layers
      case "drawing_sheet": return Layers
      case "daily_log": return Calendar
      case "punch_item": return AlertTriangle
      case "schedule_item": return Clock
      case "photo": return Camera
      case "portal_access": return FolderOpen
      default: return FileText
    }
  }

  // Handle keyboard shortcuts
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((open) => !open)
      }
    }

    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [])

  useEffect(() => {
    const search = async () => {
      if (query.length === 0) {
        setResults([])
        return
      }

      setIsLoading(true)
      try {
        const searchResults = await searchItems(query)
        setResults(searchResults)
      } catch (error) {
        console.error("Search failed:", error)
        setResults([])
      } finally {
        setIsLoading(false)
      }
    }

    const debounceTimer = setTimeout(search, 150)
    return () => clearTimeout(debounceTimer)
  }, [query, searchItems])

  const handleSelect = (result: SearchResult) => {
    setOpen(false)
    setQuery("")
    router.push(result.href)
  }

  const getTypeColor = (type: SearchResult["type"]) => {
    switch (type) {
      case "project":
        return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300"
      case "task":
        return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
      case "file":
        return "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300"
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
        return "bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-300"
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300"
    }
  }

  const groupResults = (results: SearchResult[]) => {
    const grouped: Record<string, SearchResult[]> = {}

    results.forEach(result => {
      const typeLabel = formatEntityType(result.type) + "s"
      if (!grouped[typeLabel]) {
        grouped[typeLabel] = []
      }
      grouped[typeLabel].push(result)
    })

    return grouped
  }

  const formatEntityType = (type: SearchResult["type"]): string => {
    return type.split('_').map(word =>
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ')
  }

  const formatRelativeTime = (dateString: string): string => {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) return 'today'
    if (diffDays === 1) return 'yesterday'
    if (diffDays < 7) return `${diffDays}d ago`
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
    return `${Math.floor(diffDays / 30)}mo ago`
  }

  return (
    <div className={className}>
      {/* Desktop version - button that opens command dialog */}
      <div className="hidden lg:block">
        <Button
          variant="ghost"
          className="relative h-9 w-64 justify-start rounded-none border border-input bg-secondary px-3 text-sm font-normal text-muted-foreground shadow-sm hover:bg-accent hover:text-accent-foreground transition-colors"
          onClick={() => setOpen(true)}
        >
          <Search className="mr-2 h-4 w-4" />
          <span className="truncate">Search projects, files, contacts...</span>
          <kbd className="pointer-events-none absolute right-1.5 top-1.5 hidden h-5 select-none items-center gap-1 rounded-none border border-border/60 bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
            <span className="text-xs">⌘</span>K
          </kbd>
        </Button>
      </div>

      {/* Mobile version - button that opens command dialog */}
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={() => setOpen(true)}
      >
        <Search className="h-5 w-5" />
        <span className="sr-only">Search</span>
      </Button>

      {/* Command Dialog - appears centered on screen */}
      <CommandDialog open={open} onOpenChange={setOpen} commandProps={{ shouldFilter: false }}>
        <CommandInput
          placeholder="Search projects, contacts, invoices, drawings..."
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          {isLoading && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Searching...
            </div>
          )}
          {!isLoading && query && results.length === 0 && (
            <CommandEmpty>No results found.</CommandEmpty>
          )}
          {!isLoading && results.length > 0 && (
            <>
              {Object.entries(groupResults(results)).map(([groupName, groupResults]) => (
                <CommandGroup key={groupName} heading={groupName}>
                  {groupResults.map((result) => {
                    const IconComponent = result.icon
                    return (
                      <CommandItem
                        key={result.id}
                        value={[
                          result.title,
                          result.subtitle,
                          result.description,
                          result.project_name,
                          formatEntityType(result.type),
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onSelect={() => handleSelect(result)}
                        className="flex items-start gap-3 py-3 px-2"
                      >
                        <IconComponent className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                        <div className="flex flex-col gap-1 flex-1 min-w-0">
                          <div className="font-medium truncate">{result.title}</div>
                          {result.subtitle && (
                            <div className="text-xs text-muted-foreground truncate">
                              {result.subtitle}
                            </div>
                          )}
                          {result.description && (
                            <div className="text-xs text-muted-foreground truncate line-clamp-2">
                              {result.description}
                            </div>
                          )}
                          {result.project_name && (
                            <div className="text-xs text-muted-foreground/70 truncate">
                              in {result.project_name}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge variant="secondary" className={`${getTypeColor(result.type)} text-xs`}>
                            {formatEntityType(result.type)}
                          </Badge>
                          {result.updated_at && (
                            <div className="text-xs text-muted-foreground">
                              {formatRelativeTime(result.updated_at)}
                            </div>
                          )}
                        </div>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ))}
            </>
          )}
        </CommandList>
      </CommandDialog>
    </div>
  )
}
