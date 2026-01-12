'use client'

import { useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { DrawingSheet } from '@/lib/services/drawings'

interface SheetThumbnailStripProps {
  sheets: DrawingSheet[]
  currentSheetId: string
  onSelectSheet: (sheet: DrawingSheet) => void
  className?: string
}

export function SheetThumbnailStrip({
  sheets,
  currentSheetId,
  onSelectSheet,
  className,
}: SheetThumbnailStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const currentIndex = sheets.findIndex(s => s.id === currentSheetId)

  // Scroll current sheet into view
  useEffect(() => {
    if (scrollRef.current && currentIndex >= 0) {
      const container = scrollRef.current
      const items = container.children
      const currentItem = items[currentIndex] as HTMLElement

      if (currentItem) {
        const containerRect = container.getBoundingClientRect()
        const itemRect = currentItem.getBoundingClientRect()

        // Check if item is out of view
        if (itemRect.left < containerRect.left || itemRect.right > containerRect.right) {
          currentItem.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'center',
          })
        }
      }
    }
  }, [currentIndex])

  const scrollLeft = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollBy({ left: -200, behavior: 'smooth' })
    }
  }

  const scrollRight = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollBy({ left: 200, behavior: 'smooth' })
    }
  }

  const goToPrevious = () => {
    if (currentIndex > 0) {
      onSelectSheet(sheets[currentIndex - 1])
    }
  }

  const goToNext = () => {
    if (currentIndex < sheets.length - 1) {
      onSelectSheet(sheets[currentIndex + 1])
    }
  }

  if (sheets.length === 0) return null

  return (
    <div className={cn('flex items-center gap-2 px-4 py-2 border-t bg-muted/30', className)}>
      {/* Previous sheet button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={goToPrevious}
        disabled={currentIndex <= 0}
        className="shrink-0"
      >
        <ChevronLeft className="h-5 w-5" />
      </Button>

      {/* Thumbnail scroll area */}
      <div
        ref={scrollRef}
        className="flex-1 flex gap-2 overflow-x-auto scrollbar-hide py-1"
      >
        {sheets.map((sheet) => {
          const isCurrent = sheet.id === currentSheetId

          return (
            <button
              key={sheet.id}
              onClick={() => onSelectSheet(sheet)}
              className={cn(
                'flex-shrink-0 w-16 h-12 rounded border-2 flex items-center justify-center',
                'text-xs font-mono font-medium transition-all',
                isCurrent
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-transparent bg-muted hover:bg-accent hover:border-border'
              )}
            >
              {sheet.sheet_number}
            </button>
          )
        })}
      </div>

      {/* Next sheet button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={goToNext}
        disabled={currentIndex >= sheets.length - 1}
        className="shrink-0"
      >
        <ChevronRight className="h-5 w-5" />
      </Button>
    </div>
  )
}
