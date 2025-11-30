"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Building2, FileText, CheckSquare, Search } from "@/components/icons"

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

interface SearchResult {
  id: string
  type: "project" | "task" | "file"
  title: string
  subtitle?: string
  href: string
  icon: React.ComponentType<{ className?: string }>
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
  const searchItems = async (searchQuery: string): Promise<SearchResult[]> => {
    if (!searchQuery.trim()) return []

    try {
      // Import server action
      const { searchAction } = await import("@/app/actions/dashboard")

      // Call server action
      const rawResults = await searchAction(searchQuery)

      // Transform results to include icons
      return rawResults.map(result => ({
        ...result,
        icon: result.type === "project" ? Building2 :
              result.type === "task" ? CheckSquare :
              FileText,
      }))
    } catch (error) {
      console.error("Search failed:", error)
      return []
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
  }, [query])

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
      default:
        return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300"
    }
  }

  const groupResults = (results: SearchResult[]) => {
    const grouped: Record<string, SearchResult[]> = {}

    results.forEach(result => {
      const typeLabel = result.type.charAt(0).toUpperCase() + result.type.slice(1) + "s"
      if (!grouped[typeLabel]) {
        grouped[typeLabel] = []
      }
      grouped[typeLabel].push(result)
    })

    return grouped
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
          <span className="truncate">Search project, tasks...</span>
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
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput
          placeholder="Search projects, tasks, files..."
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
                        value={result.id}
                        onSelect={() => handleSelect(result)}
                        className="flex items-center gap-3 py-3"
                      >
                        <IconComponent className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="flex flex-col gap-1 flex-1 min-w-0">
                          <div className="font-medium truncate">{result.title}</div>
                          {result.subtitle && (
                            <div className="text-xs text-muted-foreground truncate">
                              {result.subtitle}
                            </div>
                          )}
                        </div>
                        <Badge variant="secondary" className={getTypeColor(result.type)}>
                          {result.type}
                        </Badge>
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
