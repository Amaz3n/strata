'use client'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDown } from 'lucide-react'
import { DISCIPLINE_SHORT_LABELS } from '@/lib/utils/drawing-utils'
import type { DrawingDiscipline } from '@/lib/validation/drawings'

interface DisciplineTabsProps {
  counts: Record<string, number>
  selected: string | null
  onSelect: (discipline: string | null) => void
  className?: string
}

// Primary disciplines to show as tabs (most common in construction)
const PRIMARY_DISCIPLINES: DrawingDiscipline[] = ['A', 'S', 'M', 'E', 'P']

// Secondary disciplines go in overflow dropdown
const SECONDARY_DISCIPLINES: DrawingDiscipline[] = ['FP', 'C', 'L', 'I', 'G', 'T', 'SP', 'D', 'X']

export function DisciplineTabs({
  counts,
  selected,
  onSelect,
  className,
}: DisciplineTabsProps) {
  const totalCount = Object.values(counts).reduce((sum, c) => sum + c, 0)

  // Filter to disciplines that have sheets
  const primaryWithSheets = PRIMARY_DISCIPLINES.filter(d => (counts[d] || 0) > 0)
  const secondaryWithSheets = SECONDARY_DISCIPLINES.filter(d => (counts[d] || 0) > 0)

  return (
    <div className={cn('flex items-center gap-1 flex-wrap', className)}>
      {/* All tab */}
      <Button
        variant={selected === null ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => onSelect(null)}
        className="font-medium"
      >
        All {totalCount}
      </Button>

      {/* Primary discipline tabs */}
      {primaryWithSheets.map(disc => (
        <Button
          key={disc}
          variant={selected === disc ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => onSelect(disc)}
        >
          {DISCIPLINE_SHORT_LABELS[disc]} {counts[disc]}
        </Button>
      ))}

      {/* Overflow dropdown for secondary disciplines */}
      {secondaryWithSheets.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={secondaryWithSheets.includes(selected as DrawingDiscipline) ? 'secondary' : 'ghost'}
              size="sm"
            >
              +{secondaryWithSheets.length} More
              <ChevronDown className="ml-1 h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {secondaryWithSheets.map(disc => (
              <DropdownMenuItem
                key={disc}
                onClick={() => onSelect(disc)}
                className={cn(selected === disc && 'bg-accent')}
              >
                {DISCIPLINE_SHORT_LABELS[disc]}
                <span className="ml-auto text-muted-foreground">{counts[disc]}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
