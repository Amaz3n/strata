'use client'

import { useEffect, useState, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { Clock } from 'lucide-react'
import type { DrawingSheet } from '@/lib/services/drawings'

interface RecentSheetsSectionProps {
  sheets: DrawingSheet[]
  projectId: string | undefined
  onSelect: (sheet: DrawingSheet) => void
  className?: string
}

interface RecentSheetEntry {
  id: string
  viewedAt: number
}

function getStorageKey(projectId: string): string {
  return `strata:recentDrawingSheets:${projectId}`
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = now - timestamp
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays === 1) return 'Yesterday'
  return `${diffDays}d ago`
}

export function useRecentSheets(projectId: string | undefined) {
  const [recentIds, setRecentIds] = useState<RecentSheetEntry[]>([])

  // Load from localStorage
  useEffect(() => {
    if (!projectId) {
      setRecentIds([])
      return
    }

    try {
      const stored = localStorage.getItem(getStorageKey(projectId))
      if (stored) {
        const parsed = JSON.parse(stored) as RecentSheetEntry[]
        setRecentIds(parsed)
      } else {
        setRecentIds([])
      }
    } catch {
      setRecentIds([])
    }
  }, [projectId])

  // Track a sheet view
  const trackView = useCallback((sheetId: string) => {
    if (!projectId) return

    setRecentIds(prev => {
      const filtered = prev.filter(entry => entry.id !== sheetId)
      const updated: RecentSheetEntry[] = [
        { id: sheetId, viewedAt: Date.now() },
        ...filtered,
      ].slice(0, 5)

      // Persist to localStorage
      try {
        localStorage.setItem(getStorageKey(projectId), JSON.stringify(updated))
      } catch {
        // Ignore storage errors
      }

      return updated
    })
  }, [projectId])

  return { recentIds, trackView }
}

export function RecentSheetsSection({
  sheets,
  projectId,
  onSelect,
  className,
}: RecentSheetsSectionProps) {
  const { recentIds } = useRecentSheets(projectId)

  // Map recent IDs to actual sheets (filter out sheets that no longer exist)
  const recentSheets = recentIds
    .map(entry => {
      const sheet = sheets.find(s => s.id === entry.id)
      return sheet ? { sheet, viewedAt: entry.viewedAt } : null
    })
    .filter((item): item is { sheet: DrawingSheet; viewedAt: number } => item !== null)

  if (recentSheets.length === 0 || !projectId) return null

  return (
    <div className={cn('space-y-3', className)}>
      <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
        <Clock className="h-4 w-4" />
        Recently Viewed
      </h3>

      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
        {recentSheets.map(({ sheet, viewedAt }) => (
          <button
            key={sheet.id}
            onClick={() => onSelect(sheet)}
            className={cn(
              'flex-shrink-0 w-28 p-3 rounded-lg border bg-card text-left',
              'hover:border-primary hover:bg-accent transition-colors',
              'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2'
            )}
          >
            <div className="font-mono text-sm font-medium truncate">
              {sheet.sheet_number}
            </div>
            <div className="text-xs text-muted-foreground truncate mt-1">
              {sheet.sheet_title || 'Untitled'}
            </div>
            <div className="text-xs text-muted-foreground mt-2">
              {formatRelativeTime(viewedAt)}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
