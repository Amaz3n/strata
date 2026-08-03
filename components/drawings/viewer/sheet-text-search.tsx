"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronUp, Search, X } from "lucide-react"

import { searchTextRuns, type TextRun, type TextRunMatch } from "@/lib/drawings/text-runs"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Find-in-sheet.
 *
 * The pipeline already stores positioned text for every sheet; until now only
 * takeoff read it. Finding every occurrence of a schedule mark or keynote
 * ("W12x26", "GFI", a spec section) across a 42x30 sheet is a daily field
 * task that otherwise means panning and squinting.
 */

export interface SheetTextSearchProps {
  runs: TextRun[]
  /** False while the sheet's text is still downloading. */
  loading: boolean
  /** The sheet has no extracted text at all (scan with no text layer). */
  unavailable: boolean
  onClose: () => void
  /** Matches to draw on the overlay, and which one is current. */
  onMatchesChange: (matches: TextRunMatch[], activeIndex: number) => void
  /** Bring a match into view. Rect is normalized 0..1. */
  onReveal: (rect: { x: number; y: number; w: number; h: number }) => void
}

export function SheetTextSearch({
  runs,
  loading,
  unavailable,
  onClose,
  onMatchesChange,
  onReveal,
}: SheetTextSearchProps) {
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const matches = useMemo(() => searchTextRuns(runs, query), [runs, query])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // A new query starts at the first hit rather than holding a stale position.
  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  useEffect(() => {
    onMatchesChange(matches, activeIndex)
  }, [matches, activeIndex, onMatchesChange])

  const goTo = useCallback(
    (index: number) => {
      if (matches.length === 0) return
      const next = (index + matches.length) % matches.length
      setActiveIndex(next)
      const run = matches[next].run
      onReveal({ x: run.x, y: run.y, w: run.w, h: run.h })
    },
    [matches, onReveal],
  )

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      goTo(event.shiftKey ? activeIndex - 1 : activeIndex + 1)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      onClose()
    }
  }

  const status = (() => {
    if (unavailable) return "No searchable text on this sheet"
    if (loading) return "Loading sheet text…"
    if (!query.trim()) return null
    if (matches.length === 0) return "No matches"
    return `${activeIndex + 1} of ${matches.length}`
  })()

  return (
    <div className="flex items-center gap-1 border bg-background p-1 shadow-sm">
      <Search className="ml-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in sheet…"
        aria-label="Find in sheet"
        className="h-7 w-44 border-0 px-1 shadow-none focus-visible:ring-0"
      />
      {status && (
        <span
          className={cn(
            "shrink-0 whitespace-nowrap px-1 text-xs tabular-nums",
            matches.length === 0 && query.trim() && !loading && !unavailable
              ? "text-muted-foreground"
              : "text-muted-foreground",
          )}
        >
          {status}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={matches.length === 0}
        onClick={() => goTo(activeIndex - 1)}
        aria-label="Previous match"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={matches.length === 0}
        onClick={() => goTo(activeIndex + 1)}
        aria-label="Next match"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onClose}
        aria-label="Close find"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
