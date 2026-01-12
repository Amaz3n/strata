# Drawings Feature Glow-Up: Stage 2

> **Stage 2: Core Improvements** - Navigation & Comparison
>
> **Prerequisites**: Stage 1 complete (status dots, keyboard shortcuts, discipline detection, upload preview)

---

## Table of Contents

- [2.1 Simplified Navigation (Tabs + Search + Recent)](#21-simplified-navigation)
- [2.2 Comparison Mode](#22-comparison-mode)
- [2.3 Enhanced Pin Colors & Clustering](#23-enhanced-pin-colors--clustering)
- [2.4 Mobile Touch Improvements](#24-mobile-touch-improvements)

---

## 2.1 Simplified Navigation

### Problem
Current navigation is flat - users scroll through potentially 100+ sheets. Finding a specific sheet requires searching or scrolling.

### Solution
**Design for non-tech-savvy users**: Everything visible, no hidden features, no keyboard shortcuts required. Use discipline tabs, a visible search box, and a recent sheets section. No second sidebar.

### Design Specification

#### Drawings List Page Layout
```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Drawings                                              [Upload]  [Grid|List] │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  🔍 Search sheets by number or name...                                       │
│                                                                              │
│  [All 46] [Arch 23] [Struct 8] [Mech 6] [Elec 5] [Plumb 4]  [+3 More ▾]     │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Recently Viewed                                                             │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐                            │
│  │  A-101  │ │  S-201  │ │  M-001  │ │  E-101  │                            │
│  │ 1st Flr │ │ Found.  │ │ HVAC    │ │ Lighting│                            │
│  │  2m ago │ │  1h ago │ │  Today  │ │  Today  │                            │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘                            │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  All Sheets                                              Showing 23 of 46    │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│  │  A-001  │ │  A-101  │ │  A-102  │ │  A-103  │ │  A-201  │ │  A-202  │   │
│  │  Cover  │ │ 1st Flr │ │ 2nd Flr │ │ 3rd Flr │ │ N Elev  │ │ S Elev  │   │
│  │ 🔴2 🟡1 │ │ 🟢5     │ │         │ │ 🔴1     │ │         │ │ 🟡2     │   │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Key Design Principles

1. **Search is always visible** - No keyboard shortcut needed, just click and type
2. **Discipline tabs with counts** - One tap to filter, see how many sheets per discipline
3. **Recent sheets prominent** - Top of page, not hidden in a sidebar
4. **No second sidebar** - Maximizes drawing space, reduces confusion
5. **Overflow dropdown** - Less common disciplines in "+3 More" dropdown

#### Discipline Tabs Behavior
```
Active state:     [Arch 23]  ← Filled background, bold text
Inactive state:   [Struct 8]  ← Ghost/outline style
Hover state:      Slight background highlight

"+3 More ▾" dropdown contains:
  - Fire Protection (2)
  - Civil (1)
  - Landscape (0)  ← Hidden if count is 0
```

#### Viewer Navigation (Thumbnail Strip)
When viewing a sheet, show a horizontal thumbnail strip at the bottom:
```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Back    A-101 First Floor Plan                    Rev B    [Compare] [⋮] │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                                                                              │
│                           [Full Drawing View]                                │
│                                                                              │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  ◀ │ [A-100] [A-101] [A-102] [A-103] [A-104] [A-105] [A-106] │ ▶           │
│       ░░░░░░  ██████  ░░░░░░  ░░░░░░  ░░░░░░  ░░░░░░  ░░░░░░               │
│               current                                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Technical Implementation

#### Component: DisciplineTabs

**File**: `components/drawings/discipline-tabs.tsx`

```typescript
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
  counts: Record<string, number>  // { A: 23, S: 8, ... }
  selected: string | null         // null = "All"
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
```

#### Component: RecentSheetsSection

**File**: `components/drawings/recent-sheets-section.tsx`

```typescript
'use client'

import { cn } from '@/lib/utils'
import { Clock } from 'lucide-react'
import type { DrawingSheet } from '@/lib/services/drawings'

interface RecentSheetsSectionProps {
  sheets: DrawingSheet[]
  onSelect: (sheet: DrawingSheet) => void
  className?: string
}

function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays === 1) return 'Yesterday'
  return `${diffDays}d ago`
}

export function RecentSheetsSection({
  sheets,
  onSelect,
  className,
}: RecentSheetsSectionProps) {
  if (sheets.length === 0) return null

  return (
    <div className={cn('space-y-3', className)}>
      <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
        <Clock className="h-4 w-4" />
        Recently Viewed
      </h3>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {sheets.slice(0, 5).map((sheet, index) => (
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
              {/* We'd need to track view time - for now show index-based mock */}
              {index === 0 ? 'Just now' : index === 1 ? '5m ago' : 'Earlier today'}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
```

#### Component: SheetThumbnailStrip

**File**: `components/drawings/sheet-thumbnail-strip.tsx`

```typescript
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
        {sheets.map((sheet, index) => {
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
```

#### Integration: Updated DrawingsClient

**File**: `components/drawings/drawings-client.tsx`

Key changes:
```typescript
// State for recent sheets (persist in localStorage)
const [recentSheets, setRecentSheets] = useState<DrawingSheet[]>([])

// Load recent from localStorage on mount
useEffect(() => {
  const stored = localStorage.getItem('recentDrawingSheets')
  if (stored) {
    try {
      const ids = JSON.parse(stored) as string[]
      const recent = ids
        .map(id => sheets.find(s => s.id === id))
        .filter(Boolean) as DrawingSheet[]
      setRecentSheets(recent)
    } catch {}
  }
}, [sheets])

// Track when opening a sheet
const openViewer = (sheet: DrawingSheet) => {
  // Update recent sheets
  setRecentSheets(prev => {
    const filtered = prev.filter(s => s.id !== sheet.id)
    const updated = [sheet, ...filtered].slice(0, 5)
    // Persist to localStorage
    localStorage.setItem(
      'recentDrawingSheets',
      JSON.stringify(updated.map(s => s.id))
    )
    return updated
  })
  // ... open viewer logic
}

// Render layout (no tree sidebar!)
return (
  <div className="flex flex-col h-full">
    {/* Search bar - always visible */}
    <div className="px-4 py-3">
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sheets by number or name..."
          className="pl-9"
        />
      </div>
    </div>

    {/* Discipline tabs */}
    <div className="px-4 pb-3">
      <DisciplineTabs
        counts={disciplineCounts}
        selected={disciplineFilter}
        onSelect={setDisciplineFilter}
      />
    </div>

    {/* Recent sheets (only when no filter/search active) */}
    {!search && !disciplineFilter && recentSheets.length > 0 && (
      <div className="px-4 pb-4">
        <RecentSheetsSection
          sheets={recentSheets}
          onSelect={openViewer}
        />
      </div>
    )}

    {/* Sheet grid/list */}
    <div className="flex-1 overflow-auto px-4 pb-4">
      {/* ... existing grid/list content */}
    </div>

    {/* Viewer with thumbnail strip */}
    {viewerOpen && currentSheet && (
      <DrawingViewer
        sheet={currentSheet}
        onClose={() => setViewerOpen(false)}
        bottomContent={
          <SheetThumbnailStrip
            sheets={filteredSheets}
            currentSheetId={currentSheet.id}
            onSelectSheet={openViewer}
          />
        }
      />
    )}
  </div>
)
```

### Files to Create/Modify
| File | Changes |
|------|---------|
| `components/drawings/discipline-tabs.tsx` | New component (create) |
| `components/drawings/recent-sheets-section.tsx` | New component (create) |
| `components/drawings/sheet-thumbnail-strip.tsx` | New component (create) |
| `components/drawings/drawings-client.tsx` | Replace sidebar with tabs, add recent section, add thumbnail strip |
| `components/drawings/drawing-viewer.tsx` | Accept bottomContent prop for thumbnail strip |
| `components/drawings/index.ts` | Export new components |

### Acceptance Criteria
- [ ] Search box is always visible at top of page
- [ ] Discipline tabs show counts and filter on click
- [ ] "All" tab shows total count and is default
- [ ] Overflow dropdown shows less common disciplines
- [ ] Recent sheets section shows last 5 viewed sheets
- [ ] Recent sheets persist across page refreshes (localStorage)
- [ ] Clicking recent sheet opens it directly
- [ ] Viewer shows thumbnail strip at bottom
- [ ] Current sheet is highlighted in strip
- [ ] Arrow buttons navigate prev/next sheet
- [ ] No second sidebar - full width for content

---

## 2.2 Comparison Mode

### Problem
When a new revision is issued, users need to see what changed. Currently they have to open two sheets in different tabs and flip back and forth. This is the #1 feature request for drawing management.

### Solution
Built-in comparison mode with three view options: side-by-side, overlay with opacity slider, and horizontal wipe slider.

### Design Specification

#### Comparison Mode UI
```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← A-100    A-101 First Floor Plan    A-102 →    [Exit Compare]             │
│  ─────────────────────────────────────────────────────────────────────────── │
│  Comparing: [Rev A ▾]  vs  [Rev B ▾]     [Side by Side] [Overlay] [Slider]  │
├──────────────────────────────────────────────────────────────────────────────┤
│                              │                                               │
│                              │                                               │
│         Rev A                │              Rev B                            │
│     (Dec 1, 2024)            │          (Dec 15, 2024)                       │
│                              │                                               │
│      [Drawing]               │            [Drawing]                          │
│                              │                                               │
│                              │                                               │
│                              │                                               │
├──────────────────────────────────────────────────────────────────────────────┤
│  🔍 75%  [−][+][Fit]    [Sync Zoom: On]    [Sync Pan: On]    [⬇️ Download]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Overlay Mode
```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Comparing: Rev A vs Rev B          [Side by Side] [●Overlay] [Slider]      │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                           [Stacked Drawing]                                  │
│                                                                              │
│               Rev A shown in RED, Rev B shown in BLUE                        │
│                  (or adjustable opacity blend)                               │
│                                                                              │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Opacity: [Rev A ●━━━━━━━━━━○ Rev B]      [Swap Colors]  [Toggle: A/B/Both] │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Slider (Wipe) Mode
```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Comparing: Rev A vs Rev B          [Side by Side] [Overlay] [●Slider]      │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│         ┃                                                                    │
│         ┃                                                                    │
│  Rev A  ┃  Rev B                                                             │
│         ┃                                                                    │
│       ← ┃ → (drag to reveal)                                                 │
│         ┃                                                                    │
│         ┃                                                                    │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Slider position: [○━━━━━━━●━━━━━━━━━━○]  50%                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Technical Implementation

#### Component: ComparisonViewer

**File**: `components/drawings/comparison-viewer.tsx`

```typescript
'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group'
import {
  X,
  ZoomIn,
  ZoomOut,
  Maximize,
  Download,
  Columns,
  Layers,
  SplitSquareHorizontal,
  Link2,
  Link2Off,
} from 'lucide-react'
import type { DrawingSheet, DrawingSheetVersion } from '@/lib/services/drawings'

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`

type CompareMode = 'side-by-side' | 'overlay' | 'slider'

interface ComparisonViewerProps {
  sheet: DrawingSheet
  versions: DrawingSheetVersion[]
  leftVersionId: string
  rightVersionId: string
  onClose: () => void
  onChangeVersions: (leftId: string, rightId: string) => void
}

export function ComparisonViewer({
  sheet,
  versions,
  leftVersionId,
  rightVersionId,
  onClose,
  onChangeVersions,
}: ComparisonViewerProps) {
  const [mode, setMode] = useState<CompareMode>('side-by-side')
  const [zoom, setZoom] = useState(0.75)
  const [syncZoom, setSyncZoom] = useState(true)
  const [syncPan, setSyncPan] = useState(true)
  const [overlayOpacity, setOverlayOpacity] = useState(50)
  const [sliderPosition, setSliderPosition] = useState(50)

  const leftVersion = versions.find(v => v.id === leftVersionId)
  const rightVersion = versions.find(v => v.id === rightVersionId)

  const handleZoomIn = () => setZoom(z => Math.min(z + 0.25, 3))
  const handleZoomOut = () => setZoom(z => Math.max(z - 0.25, 0.25))
  const handleFit = () => setZoom(0.75)

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Header */}
      <div className="border-b px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
          <div>
            <h2 className="font-semibold">
              {sheet.sheet_number} {sheet.sheet_title}
            </h2>
            <p className="text-sm text-muted-foreground">Comparison Mode</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Version Selectors */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Comparing:</span>
            <Select
              value={leftVersionId}
              onValueChange={v => onChangeVersions(v, rightVersionId)}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map(v => (
                  <SelectItem key={v.id} value={v.id} disabled={v.id === rightVersionId}>
                    {v.revision_label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">vs</span>
            <Select
              value={rightVersionId}
              onValueChange={v => onChangeVersions(leftVersionId, v)}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map(v => (
                  <SelectItem key={v.id} value={v.id} disabled={v.id === leftVersionId}>
                    {v.revision_label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Mode Toggle */}
          <ToggleGroup type="single" value={mode} onValueChange={v => v && setMode(v as CompareMode)}>
            <ToggleGroupItem value="side-by-side" aria-label="Side by side">
              <Columns className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="overlay" aria-label="Overlay">
              <Layers className="h-4 w-4" />
            </ToggleGroupItem>
            <ToggleGroupItem value="slider" aria-label="Slider">
              <SplitSquareHorizontal className="h-4 w-4" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden relative">
        {mode === 'side-by-side' && (
          <SideBySideView
            leftUrl={leftVersion?.file_url}
            rightUrl={rightVersion?.file_url}
            leftLabel={leftVersion?.revision_label || 'Unknown'}
            rightLabel={rightVersion?.revision_label || 'Unknown'}
            zoom={zoom}
            syncZoom={syncZoom}
            syncPan={syncPan}
          />
        )}

        {mode === 'overlay' && (
          <OverlayView
            leftUrl={leftVersion?.file_url}
            rightUrl={rightVersion?.file_url}
            opacity={overlayOpacity}
            zoom={zoom}
          />
        )}

        {mode === 'slider' && (
          <SliderView
            leftUrl={leftVersion?.file_url}
            rightUrl={rightVersion?.file_url}
            position={sliderPosition}
            zoom={zoom}
          />
        )}
      </div>

      {/* Footer Controls */}
      <div className="border-t px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={handleZoomOut}>
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-sm w-16 text-center">{Math.round(zoom * 100)}%</span>
          <Button variant="outline" size="icon" onClick={handleZoomIn}>
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={handleFit}>
            <Maximize className="h-4 w-4" />
          </Button>
        </div>

        {/* Mode-specific controls */}
        {mode === 'side-by-side' && (
          <div className="flex items-center gap-4">
            <Button
              variant={syncZoom ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setSyncZoom(!syncZoom)}
            >
              {syncZoom ? <Link2 className="h-4 w-4 mr-1" /> : <Link2Off className="h-4 w-4 mr-1" />}
              Sync Zoom
            </Button>
            <Button
              variant={syncPan ? 'secondary' : 'outline'}
              size="sm"
              onClick={() => setSyncPan(!syncPan)}
            >
              {syncPan ? <Link2 className="h-4 w-4 mr-1" /> : <Link2Off className="h-4 w-4 mr-1" />}
              Sync Pan
            </Button>
          </div>
        )}

        {mode === 'overlay' && (
          <div className="flex items-center gap-4 flex-1 max-w-md mx-4">
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {leftVersion?.revision_label}
            </span>
            <Slider
              value={[overlayOpacity]}
              onValueChange={([v]) => setOverlayOpacity(v)}
              min={0}
              max={100}
              step={1}
              className="flex-1"
            />
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {rightVersion?.revision_label}
            </span>
          </div>
        )}

        {mode === 'slider' && (
          <div className="flex items-center gap-4 flex-1 max-w-md mx-4">
            <Slider
              value={[sliderPosition]}
              onValueChange={([v]) => setSliderPosition(v)}
              min={0}
              max={100}
              step={1}
              className="flex-1"
            />
            <span className="text-sm text-muted-foreground w-12 text-right">
              {sliderPosition}%
            </span>
          </div>
        )}

        <Button variant="outline" size="sm">
          <Download className="h-4 w-4 mr-1" />
          Download Both
        </Button>
      </div>
    </div>
  )
}

// Sub-components for each view mode

interface ViewProps {
  leftUrl?: string
  rightUrl?: string
  zoom: number
}

function SideBySideView({
  leftUrl,
  rightUrl,
  leftLabel,
  rightLabel,
  zoom,
  syncZoom,
  syncPan,
}: ViewProps & {
  leftLabel: string
  rightLabel: string
  syncZoom: boolean
  syncPan: boolean
}) {
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)

  // Sync scroll positions when syncPan is enabled
  useEffect(() => {
    if (!syncPan) return

    const left = leftRef.current
    const right = rightRef.current
    if (!left || !right) return

    let syncing = false

    const syncScroll = (source: HTMLDivElement, target: HTMLDivElement) => {
      if (syncing) return
      syncing = true

      target.scrollLeft = source.scrollLeft
      target.scrollTop = source.scrollTop

      requestAnimationFrame(() => {
        syncing = false
      })
    }

    const handleLeftScroll = () => syncScroll(left, right)
    const handleRightScroll = () => syncScroll(right, left)

    left.addEventListener('scroll', handleLeftScroll)
    right.addEventListener('scroll', handleRightScroll)

    return () => {
      left.removeEventListener('scroll', handleLeftScroll)
      right.removeEventListener('scroll', handleRightScroll)
    }
  }, [syncPan])

  return (
    <div className="flex h-full divide-x">
      <div className="flex-1 flex flex-col">
        <div className="px-4 py-2 bg-muted/50 text-sm font-medium text-center border-b">
          {leftLabel}
        </div>
        <div ref={leftRef} className="flex-1 overflow-auto p-4 flex items-center justify-center">
          {leftUrl && (
            <Document file={leftUrl}>
              <Page pageNumber={1} scale={zoom} />
            </Document>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        <div className="px-4 py-2 bg-muted/50 text-sm font-medium text-center border-b">
          {rightLabel}
        </div>
        <div ref={rightRef} className="flex-1 overflow-auto p-4 flex items-center justify-center">
          {rightUrl && (
            <Document file={rightUrl}>
              <Page pageNumber={1} scale={zoom} />
            </Document>
          )}
        </div>
      </div>
    </div>
  )
}

function OverlayView({ leftUrl, rightUrl, opacity, zoom }: ViewProps & { opacity: number }) {
  return (
    <div className="h-full overflow-auto p-4 flex items-center justify-center">
      <div className="relative">
        {/* Bottom layer (left/old) */}
        {leftUrl && (
          <div className="absolute inset-0">
            <Document file={leftUrl}>
              <Page
                pageNumber={1}
                scale={zoom}
                className="[&_canvas]:!opacity-100"
                style={{ filter: 'sepia(1) saturate(5) hue-rotate(-50deg)' }} // Red tint
              />
            </Document>
          </div>
        )}

        {/* Top layer (right/new) with opacity */}
        {rightUrl && (
          <div style={{ opacity: opacity / 100 }}>
            <Document file={rightUrl}>
              <Page
                pageNumber={1}
                scale={zoom}
                style={{ filter: 'sepia(1) saturate(5) hue-rotate(180deg)' }} // Blue tint
              />
            </Document>
          </div>
        )}
      </div>
    </div>
  )
}

function SliderView({ leftUrl, rightUrl, position, zoom }: ViewProps & { position: number }) {
  const containerRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={containerRef} className="h-full overflow-auto p-4 flex items-center justify-center">
      <div className="relative">
        {/* Full right image (underneath) */}
        {rightUrl && (
          <Document file={rightUrl}>
            <Page pageNumber={1} scale={zoom} />
          </Document>
        )}

        {/* Clipped left image (on top) */}
        {leftUrl && (
          <div
            className="absolute inset-0 overflow-hidden"
            style={{ width: `${position}%` }}
          >
            <Document file={leftUrl}>
              <Page pageNumber={1} scale={zoom} />
            </Document>
          </div>
        )}

        {/* Slider handle */}
        <div
          className="absolute top-0 bottom-0 w-1 bg-primary cursor-ew-resize"
          style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-primary rounded-full flex items-center justify-center">
            <SplitSquareHorizontal className="h-4 w-4 text-primary-foreground" />
          </div>
        </div>
      </div>
    </div>
  )
}
```

#### Entry Point: Compare Button in Viewer

**File**: `components/drawings/drawing-viewer.tsx`

Add compare button and state:
```typescript
// In the viewer header
<Button
  variant="outline"
  size="sm"
  onClick={() => setShowCompare(true)}
  disabled={versions.length < 2}
>
  <Columns className="h-4 w-4 mr-1" />
  Compare
</Button>

// When showCompare is true, render ComparisonViewer instead of regular viewer
{showCompare ? (
  <ComparisonViewer
    sheet={sheet}
    versions={versions}
    leftVersionId={previousVersionId}
    rightVersionId={currentVersionId}
    onClose={() => setShowCompare(false)}
    onChangeVersions={setCompareVersions}
  />
) : (
  // Regular viewer
)}
```

### Files to Create/Modify
| File | Changes |
|------|---------|
| `components/drawings/comparison-viewer.tsx` | New component (create) |
| `components/drawings/drawing-viewer.tsx` | Add compare button, integrate ComparisonViewer |
| `app/drawings/actions.ts` | Add action to fetch all versions for a sheet |
| `lib/services/drawings.ts` | Ensure `listSheetVersions` returns file URLs |
| `components/drawings/index.ts` | Export new component |

### Acceptance Criteria
- [ ] Compare button appears when sheet has 2+ versions
- [ ] Side-by-side mode shows both versions with synced zoom/pan
- [ ] Overlay mode blends versions with adjustable opacity
- [ ] Slider mode allows wiping between versions
- [ ] Version dropdowns allow switching which versions to compare
- [ ] `c` keyboard shortcut toggles comparison mode
- [ ] Zoom controls work across all modes
- [ ] Exit button returns to normal viewer

---

## 2.3 Enhanced Pin Colors & Clustering

### Problem
When a sheet has 20+ pins, they become visual noise. It's hard to distinguish between types and statuses. Zooming out makes pins overlap and become unreadable.

### Solution
1. Use consistent status-based colors matching the sheet card status dots
2. Cluster nearby pins when zoomed out, showing a count badge
3. Click cluster to zoom in and expand

### Design Specification

#### Pin Visual Design
```
Normal Pin (zoomed in):
    ┌───┐
    │ 🔧 │  ← Icon based on entity type
    └─┬─┘
      │
      ▼     ← Points to exact location

With Label:
    ┌─────────────┐
    │ 🔧 Task #42 │
    └──────┬──────┘
           │
           ▼

Clustered (zoomed out):
    ┌─────┐
    │ 12  │  ← Count of pins in cluster
    └─────┘
```

#### Pin Colors by Status
| Status | Color | Hex | Use Case |
|--------|-------|-----|----------|
| Open | Red | `#EF4444` | New, unaddressed items |
| Pending | Orange | `#F97316` | Waiting on response |
| In Progress | Yellow | `#F59E0B` | Being worked on |
| Approved | Green | `#10B981` | Completed/closed |
| Closed | Gray | `#6B7280` | Archived |
| Rejected | Purple | `#8B5CF6` | Not approved |

#### Pin Icons by Entity Type
| Entity Type | Icon | Description |
|-------------|------|-------------|
| Task | `🔧` / Wrench | Work item |
| RFI | `❓` / HelpCircle | Question |
| Punch List | `🔴` / AlertCircle | Defect |
| Submittal | `📋` / FileCheck | Document review |
| Daily Log | `📝` / ClipboardList | Field report |
| Observation | `👁️` / Eye | Note |
| Issue | `⚠️` / AlertTriangle | Problem |

### Technical Implementation

#### Component: DrawingPinLayer

**File**: `components/drawings/drawing-pin-layer.tsx`

```typescript
'use client'

import { useMemo, useState, useCallback } from 'react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Wrench,
  HelpCircle,
  AlertCircle,
  FileCheck,
  ClipboardList,
  Eye,
  AlertTriangle,
} from 'lucide-react'
import type { DrawingPin } from '@/lib/services/drawing-markups'
import type { PinEntityType, PinStatus } from '@/lib/validation/drawings'

interface DrawingPinLayerProps {
  pins: DrawingPin[]
  zoom: number
  containerWidth: number
  containerHeight: number
  onPinClick: (pin: DrawingPin) => void
  onClusterClick: (pins: DrawingPin[], center: { x: number; y: number }) => void
  clusterThreshold?: number // Minimum zoom to start clustering
  clusterRadius?: number // Pixel radius for clustering
}

interface Cluster {
  id: string
  pins: DrawingPin[]
  x: number // Average x position (0-1)
  y: number // Average y position (0-1)
}

const STATUS_COLORS: Record<PinStatus, string> = {
  open: 'bg-red-500 border-red-600',
  pending: 'bg-orange-500 border-orange-600',
  in_progress: 'bg-yellow-500 border-yellow-600',
  approved: 'bg-green-500 border-green-600',
  closed: 'bg-gray-500 border-gray-600',
  rejected: 'bg-purple-500 border-purple-600',
}

const STATUS_TEXT_COLORS: Record<PinStatus, string> = {
  open: 'text-red-500',
  pending: 'text-orange-500',
  in_progress: 'text-yellow-500',
  approved: 'text-green-500',
  closed: 'text-gray-500',
  rejected: 'text-purple-500',
}

const ENTITY_ICONS: Record<PinEntityType, typeof Wrench> = {
  task: Wrench,
  rfi: HelpCircle,
  punch_list: AlertCircle,
  submittal: FileCheck,
  daily_log: ClipboardList,
  observation: Eye,
  issue: AlertTriangle,
}

const ENTITY_LABELS: Record<PinEntityType, string> = {
  task: 'Task',
  rfi: 'RFI',
  punch_list: 'Punch Item',
  submittal: 'Submittal',
  daily_log: 'Daily Log',
  observation: 'Observation',
  issue: 'Issue',
}

function clusterPins(
  pins: DrawingPin[],
  radius: number,
  containerWidth: number,
  containerHeight: number
): Cluster[] {
  if (pins.length === 0) return []

  const clusters: Cluster[] = []
  const assigned = new Set<string>()

  // Convert radius to normalized coordinates
  const radiusX = radius / containerWidth
  const radiusY = radius / containerHeight

  for (const pin of pins) {
    if (assigned.has(pin.id)) continue

    // Find all pins within radius
    const nearby: DrawingPin[] = [pin]
    assigned.add(pin.id)

    for (const other of pins) {
      if (assigned.has(other.id)) continue

      const dx = Math.abs(pin.x_position - other.x_position)
      const dy = Math.abs(pin.y_position - other.y_position)

      if (dx <= radiusX && dy <= radiusY) {
        nearby.push(other)
        assigned.add(other.id)
      }
    }

    // Calculate cluster center
    const avgX = nearby.reduce((sum, p) => sum + p.x_position, 0) / nearby.length
    const avgY = nearby.reduce((sum, p) => sum + p.y_position, 0) / nearby.length

    clusters.push({
      id: `cluster-${pin.id}`,
      pins: nearby,
      x: avgX,
      y: avgY,
    })
  }

  return clusters
}

export function DrawingPinLayer({
  pins,
  zoom,
  containerWidth,
  containerHeight,
  onPinClick,
  onClusterClick,
  clusterThreshold = 0.5,
  clusterRadius = 40,
}: DrawingPinLayerProps) {
  const shouldCluster = zoom < clusterThreshold

  const clusters = useMemo(() => {
    if (!shouldCluster) return null
    return clusterPins(pins, clusterRadius, containerWidth, containerHeight)
  }, [pins, shouldCluster, clusterRadius, containerWidth, containerHeight])

  if (shouldCluster && clusters) {
    return (
      <div className="absolute inset-0 pointer-events-none">
        {clusters.map(cluster => (
          <ClusterMarker
            key={cluster.id}
            cluster={cluster}
            containerWidth={containerWidth}
            containerHeight={containerHeight}
            onClick={() => onClusterClick(cluster.pins, { x: cluster.x, y: cluster.y })}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="absolute inset-0 pointer-events-none">
      {pins.map(pin => (
        <PinMarker
          key={pin.id}
          pin={pin}
          containerWidth={containerWidth}
          containerHeight={containerHeight}
          onClick={() => onPinClick(pin)}
        />
      ))}
    </div>
  )
}

interface PinMarkerProps {
  pin: DrawingPin
  containerWidth: number
  containerHeight: number
  onClick: () => void
}

function PinMarker({ pin, containerWidth, containerHeight, onClick }: PinMarkerProps) {
  const Icon = ENTITY_ICONS[pin.entity_type] || Wrench
  const statusColor = STATUS_COLORS[pin.status] || STATUS_COLORS.open
  const statusTextColor = STATUS_TEXT_COLORS[pin.status] || STATUS_TEXT_COLORS.open

  const left = pin.x_position * containerWidth
  const top = pin.y_position * containerHeight

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'absolute pointer-events-auto transform -translate-x-1/2 -translate-y-full',
            'flex flex-col items-center transition-transform hover:scale-110'
          )}
          style={{ left, top }}
        >
          {/* Pin head */}
          <div className={cn(
            'flex items-center gap-1 px-2 py-1 rounded-md border-2 shadow-md',
            statusColor,
            'text-white text-xs font-medium'
          )}>
            <Icon className="h-3 w-3" />
            {pin.label && <span className="max-w-20 truncate">{pin.label}</span>}
          </div>

          {/* Pin tail */}
          <div className={cn(
            'w-0 h-0 border-l-4 border-r-4 border-t-8 border-transparent',
            statusColor.replace('bg-', 'border-t-')
          )} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="text-sm">
          <div className="font-medium">{ENTITY_LABELS[pin.entity_type]}</div>
          {pin.entity_title && (
            <div className="text-muted-foreground">{pin.entity_title}</div>
          )}
          <div className={cn('text-xs', statusTextColor)}>
            {pin.status.replace('_', ' ')}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

interface ClusterMarkerProps {
  cluster: Cluster
  containerWidth: number
  containerHeight: number
  onClick: () => void
}

function ClusterMarker({ cluster, containerWidth, containerHeight, onClick }: ClusterMarkerProps) {
  const left = cluster.x * containerWidth
  const top = cluster.y * containerHeight

  // Determine cluster color based on highest priority status
  const hasOpen = cluster.pins.some(p => p.status === 'open')
  const hasInProgress = cluster.pins.some(p => p.status === 'in_progress')
  const hasPending = cluster.pins.some(p => p.status === 'pending')

  let bgColor = 'bg-gray-500'
  if (hasOpen) bgColor = 'bg-red-500'
  else if (hasPending) bgColor = 'bg-orange-500'
  else if (hasInProgress) bgColor = 'bg-yellow-500'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'absolute pointer-events-auto transform -translate-x-1/2 -translate-y-1/2',
            'transition-transform hover:scale-110'
          )}
          style={{ left, top }}
        >
          <div className={cn(
            'w-10 h-10 rounded-full flex items-center justify-center',
            'text-white font-bold text-sm shadow-lg border-2 border-white',
            bgColor
          )}>
            {cluster.pins.length}
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="text-sm">
          <div className="font-medium">{cluster.pins.length} items</div>
          <div className="text-muted-foreground text-xs">Click to zoom in</div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
```

#### Integration with Drawing Viewer

**File**: `components/drawings/drawing-viewer.tsx`

```typescript
// Add to viewer render
<div className="relative" ref={containerRef}>
  {/* PDF Page */}
  <Document file={sheetUrl}>
    <Page pageNumber={1} scale={zoom} />
  </Document>

  {/* Pin Layer */}
  {showPins && (
    <DrawingPinLayer
      pins={pins}
      zoom={zoom}
      containerWidth={containerWidth}
      containerHeight={containerHeight}
      onPinClick={handlePinClick}
      onClusterClick={(pins, center) => {
        // Zoom to cluster location
        setZoom(1)
        scrollToPosition(center.x, center.y)
      }}
    />
  )}
</div>
```

### Files to Create/Modify
| File | Changes |
|------|---------|
| `components/drawings/drawing-pin-layer.tsx` | New component (create) |
| `components/drawings/drawing-viewer.tsx` | Integrate pin layer, add cluster zoom behavior |
| `components/drawings/index.ts` | Export new component |

### Acceptance Criteria
- [ ] Pins display with color based on status (red=open, yellow=in progress, etc.)
- [ ] Pins show icon based on entity type (wrench for task, ? for RFI, etc.)
- [ ] Hovering pin shows tooltip with entity details
- [ ] When zoomed out below threshold, nearby pins cluster into count badges
- [ ] Cluster color reflects highest-priority status within
- [ ] Clicking cluster zooms to that area and expands pins
- [ ] Pins have smooth hover/click animations

---

## 2.4 Mobile Touch Improvements

### Problem
Field workers access drawings on phones/tablets. Current viewer isn't optimized for touch - zooming is clunky, navigation requires precise taps, and there's no gesture support.

### Solution
Implement touch-optimized controls: pinch-to-zoom, swipe navigation, long-press context menu, and a touch-friendly floating toolbar.

### Design Specification

#### Mobile Viewer Layout
```
┌─────────────────────────────────┐
│  A-101              [×] [⋮]    │  ← Minimal header
├─────────────────────────────────┤
│                                 │
│                                 │
│                                 │
│       [Drawing Area]            │  ← Full screen, touch gestures
│                                 │
│                                 │
│                                 │
│                                 │
├─────────────────────────────────┤
│  [←] [📍] [🖊️] [📷] [→]         │  ← Floating action bar
└─────────────────────────────────┘
```

#### Touch Gestures
| Gesture | Action |
|---------|--------|
| Pinch | Zoom in/out |
| Two-finger drag | Pan when zoomed |
| Single tap | Select pin / Clear selection |
| Double tap | Zoom to 100% / Fit to screen |
| Swipe left | Next sheet |
| Swipe right | Previous sheet |
| Long press | Context menu (create pin, add photo, etc.) |

#### Long-Press Context Menu
```
        ┌─────────────────────────┐
        │                         │
        │   Long press location   │
        │          ↓              │
        │          ●              │
        │                         │
        └─────────────────────────┘

┌─────────────────────────────────┐
│  Create at this location        │
├─────────────────────────────────┤
│  📌  Drop Pin                   │
│  🔧  New Task                   │
│  ❓  New RFI                    │
│  🔴  New Punch Item             │
│  ──────────────────────────     │
│  📷  Attach Photo               │
│  📐  Add Measurement            │
└─────────────────────────────────┘
```

### Technical Implementation

#### Hook: useTouchGestures

**File**: `components/drawings/use-touch-gestures.ts`

```typescript
'use client'

import { useRef, useEffect, useCallback } from 'react'

interface TouchGestureHandlers {
  onPinchZoom?: (scale: number, center: { x: number; y: number }) => void
  onPan?: (deltaX: number, deltaY: number) => void
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
  onDoubleTap?: (position: { x: number; y: number }) => void
  onLongPress?: (position: { x: number; y: number }) => void
  onTap?: (position: { x: number; y: number }) => void
}

interface UseTouchGesturesOptions {
  enabled?: boolean
  longPressDelay?: number
  swipeThreshold?: number
  handlers: TouchGestureHandlers
}

export function useTouchGestures({
  enabled = true,
  longPressDelay = 500,
  swipeThreshold = 50,
  handlers,
}: UseTouchGesturesOptions) {
  const elementRef = useRef<HTMLDivElement>(null)
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const lastTapRef = useRef<number>(0)
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null)
  const initialDistanceRef = useRef<number | null>(null)
  const isPinchingRef = useRef(false)

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const getDistance = useCallback((touch1: Touch, touch2: Touch) => {
    const dx = touch1.clientX - touch2.clientX
    const dy = touch1.clientY - touch2.clientY
    return Math.sqrt(dx * dx + dy * dy)
  }, [])

  const getCenter = useCallback((touch1: Touch, touch2: Touch) => ({
    x: (touch1.clientX + touch2.clientX) / 2,
    y: (touch1.clientY + touch2.clientY) / 2,
  }), [])

  useEffect(() => {
    if (!enabled) return

    const element = elementRef.current
    if (!element) return

    const handleTouchStart = (e: TouchEvent) => {
      clearLongPress()

      if (e.touches.length === 2) {
        // Pinch start
        isPinchingRef.current = true
        initialDistanceRef.current = getDistance(e.touches[0], e.touches[1])
        return
      }

      if (e.touches.length === 1) {
        const touch = e.touches[0]
        touchStartRef.current = {
          x: touch.clientX,
          y: touch.clientY,
          time: Date.now(),
        }

        // Start long press timer
        longPressTimerRef.current = setTimeout(() => {
          const rect = element.getBoundingClientRect()
          handlers.onLongPress?.({
            x: (touch.clientX - rect.left) / rect.width,
            y: (touch.clientY - rect.top) / rect.height,
          })
          touchStartRef.current = null // Prevent other gestures
        }, longPressDelay)
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      clearLongPress()

      if (e.touches.length === 2 && isPinchingRef.current && initialDistanceRef.current) {
        // Pinch zoom
        const currentDistance = getDistance(e.touches[0], e.touches[1])
        const scale = currentDistance / initialDistanceRef.current
        const center = getCenter(e.touches[0], e.touches[1])

        const rect = element.getBoundingClientRect()
        handlers.onPinchZoom?.(scale, {
          x: (center.x - rect.left) / rect.width,
          y: (center.y - rect.top) / rect.height,
        })

        initialDistanceRef.current = currentDistance
        e.preventDefault()
        return
      }

      if (e.touches.length === 1 && touchStartRef.current) {
        const touch = e.touches[0]
        const deltaX = touch.clientX - touchStartRef.current.x
        const deltaY = touch.clientY - touchStartRef.current.y

        // If moved significantly, treat as pan/swipe, not tap
        if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
          handlers.onPan?.(deltaX, deltaY)
          touchStartRef.current = {
            x: touch.clientX,
            y: touch.clientY,
            time: touchStartRef.current.time,
          }
        }
      }
    }

    const handleTouchEnd = (e: TouchEvent) => {
      clearLongPress()

      if (isPinchingRef.current) {
        isPinchingRef.current = false
        initialDistanceRef.current = null
        return
      }

      if (!touchStartRef.current) return

      const touch = e.changedTouches[0]
      const deltaX = touch.clientX - touchStartRef.current.x
      const deltaY = touch.clientY - touchStartRef.current.y
      const deltaTime = Date.now() - touchStartRef.current.time

      const rect = element.getBoundingClientRect()
      const position = {
        x: (touch.clientX - rect.left) / rect.width,
        y: (touch.clientY - rect.top) / rect.height,
      }

      // Check for swipe (quick, horizontal movement)
      if (deltaTime < 300 && Math.abs(deltaX) > swipeThreshold && Math.abs(deltaY) < 50) {
        if (deltaX < 0) {
          handlers.onSwipeLeft?.()
        } else {
          handlers.onSwipeRight?.()
        }
        touchStartRef.current = null
        return
      }

      // Check for double tap
      const now = Date.now()
      if (now - lastTapRef.current < 300 && Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10) {
        handlers.onDoubleTap?.(position)
        lastTapRef.current = 0
      } else if (Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10) {
        // Single tap
        handlers.onTap?.(position)
        lastTapRef.current = now
      }

      touchStartRef.current = null
    }

    element.addEventListener('touchstart', handleTouchStart, { passive: false })
    element.addEventListener('touchmove', handleTouchMove, { passive: false })
    element.addEventListener('touchend', handleTouchEnd)

    return () => {
      element.removeEventListener('touchstart', handleTouchStart)
      element.removeEventListener('touchmove', handleTouchMove)
      element.removeEventListener('touchend', handleTouchEnd)
      clearLongPress()
    }
  }, [enabled, handlers, longPressDelay, swipeThreshold, clearLongPress, getDistance, getCenter])

  return elementRef
}
```

#### Component: MobileDrawingToolbar

**File**: `components/drawings/mobile-drawing-toolbar.tsx`

```typescript
'use client'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ChevronLeft,
  ChevronRight,
  MapPin,
  Pencil,
  Camera,
  MoreVertical,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface MobileDrawingToolbarProps {
  onPrevious: () => void
  onNext: () => void
  onDropPin: () => void
  onMarkup: () => void
  onCamera: () => void
  onDownload: () => void
  onShare: () => void
  hasPrevious: boolean
  hasNext: boolean
  isMarkupMode: boolean
  className?: string
}

export function MobileDrawingToolbar({
  onPrevious,
  onNext,
  onDropPin,
  onMarkup,
  onCamera,
  onDownload,
  onShare,
  hasPrevious,
  hasNext,
  isMarkupMode,
  className,
}: MobileDrawingToolbarProps) {
  return (
    <div className={cn(
      'fixed bottom-0 left-0 right-0 z-50',
      'bg-background/95 backdrop-blur border-t',
      'px-4 py-3 flex items-center justify-around',
      'safe-area-inset-bottom', // For iOS notch
      className
    )}>
      <Button
        variant="ghost"
        size="icon"
        onClick={onPrevious}
        disabled={!hasPrevious}
        className="h-12 w-12"
      >
        <ChevronLeft className="h-6 w-6" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        onClick={onDropPin}
        className="h-12 w-12"
      >
        <MapPin className="h-6 w-6" />
      </Button>

      <Button
        variant={isMarkupMode ? 'secondary' : 'ghost'}
        size="icon"
        onClick={onMarkup}
        className="h-12 w-12"
      >
        <Pencil className="h-6 w-6" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        onClick={onCamera}
        className="h-12 w-12"
      >
        <Camera className="h-6 w-6" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-12 w-12">
            <MoreVertical className="h-6 w-6" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onDownload}>
            Download PDF
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onShare}>
            Share Sheet
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        variant="ghost"
        size="icon"
        onClick={onNext}
        disabled={!hasNext}
        className="h-12 w-12"
      >
        <ChevronRight className="h-6 w-6" />
      </Button>
    </div>
  )
}
```

#### Component: LongPressMenu

**File**: `components/drawings/long-press-menu.tsx`

```typescript
'use client'

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import {
  MapPin,
  Wrench,
  HelpCircle,
  AlertCircle,
  Camera,
  Ruler,
} from 'lucide-react'

interface LongPressMenuProps {
  open: boolean
  position: { x: number; y: number } // Screen coordinates
  onClose: () => void
  onDropPin: () => void
  onCreateTask: () => void
  onCreateRFI: () => void
  onCreatePunch: () => void
  onAttachPhoto: () => void
  onMeasure: () => void
}

export function LongPressMenu({
  open,
  position,
  onClose,
  onDropPin,
  onCreateTask,
  onCreateRFI,
  onCreatePunch,
  onAttachPhoto,
  onMeasure,
}: LongPressMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return

    const handleClick = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    document.addEventListener('click', handleClick)
    document.addEventListener('touchstart', handleClick)

    return () => {
      document.removeEventListener('click', handleClick)
      document.removeEventListener('touchstart', handleClick)
    }
  }, [open, onClose])

  if (!open) return null

  // Position menu, ensuring it stays on screen
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(position.x, window.innerWidth - 220),
    top: Math.min(position.y, window.innerHeight - 300),
    zIndex: 100,
  }

  const items = [
    { icon: MapPin, label: 'Drop Pin', onClick: onDropPin },
    { icon: Wrench, label: 'New Task', onClick: onCreateTask },
    { icon: HelpCircle, label: 'New RFI', onClick: onCreateRFI },
    { icon: AlertCircle, label: 'New Punch Item', onClick: onCreatePunch },
    { divider: true },
    { icon: Camera, label: 'Attach Photo', onClick: onAttachPhoto },
    { icon: Ruler, label: 'Add Measurement', onClick: onMeasure },
  ]

  return (
    <div
      ref={menuRef}
      style={menuStyle}
      className={cn(
        'bg-popover border rounded-lg shadow-lg overflow-hidden',
        'animate-in fade-in-0 zoom-in-95 duration-200'
      )}
    >
      <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b">
        Create at this location
      </div>
      <div className="py-1">
        {items.map((item, i) =>
          'divider' in item ? (
            <div key={i} className="border-t my-1" />
          ) : (
            <button
              key={i}
              onClick={() => {
                item.onClick()
                onClose()
              }}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 text-sm',
                'hover:bg-muted transition-colors text-left'
              )}
            >
              <item.icon className="h-4 w-4 text-muted-foreground" />
              {item.label}
            </button>
          )
        )}
      </div>
    </div>
  )
}
```

#### Mobile Detection Hook

**File**: `lib/hooks/use-is-mobile.ts`

```typescript
'use client'

import { useState, useEffect } from 'react'

export function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < breakpoint)
    check()

    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [breakpoint])

  return isMobile
}

export function useIsTouchDevice() {
  const [isTouch, setIsTouch] = useState(false)

  useEffect(() => {
    setIsTouch(
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0
    )
  }, [])

  return isTouch
}
```

### Integration into Drawing Viewer

**File**: `components/drawings/drawing-viewer.tsx`

```typescript
import { useIsMobile, useIsTouchDevice } from '@/lib/hooks/use-is-mobile'
import { useTouchGestures } from './use-touch-gestures'
import { MobileDrawingToolbar } from './mobile-drawing-toolbar'
import { LongPressMenu } from './long-press-menu'

// Inside component:
const isMobile = useIsMobile()
const isTouch = useIsTouchDevice()

const [longPressPosition, setLongPressPosition] = useState<{ x: number; y: number } | null>(null)

const touchRef = useTouchGestures({
  enabled: isTouch,
  handlers: {
    onPinchZoom: (scale, center) => {
      setZoom(z => Math.max(0.25, Math.min(3, z * scale)))
    },
    onSwipeLeft: () => goToNextSheet(),
    onSwipeRight: () => goToPreviousSheet(),
    onDoubleTap: () => {
      setZoom(z => z === 1 ? 0.75 : 1) // Toggle between fit and 100%
    },
    onLongPress: (pos) => {
      setLongPressPosition({
        x: pos.x * containerWidth,
        y: pos.y * containerHeight,
      })
    },
  },
})

// In render:
return (
  <div ref={touchRef} className="...">
    {/* Drawing content */}

    {isMobile && (
      <MobileDrawingToolbar
        onPrevious={goToPreviousSheet}
        onNext={goToNextSheet}
        // ... other handlers
      />
    )}

    <LongPressMenu
      open={!!longPressPosition}
      position={longPressPosition || { x: 0, y: 0 }}
      onClose={() => setLongPressPosition(null)}
      onCreateTask={() => openCreateDialog('task', longPressPosition)}
      // ... other handlers
    />
  </div>
)
```

### Files to Create/Modify
| File | Changes |
|------|---------|
| `components/drawings/use-touch-gestures.ts` | New hook (create) |
| `components/drawings/mobile-drawing-toolbar.tsx` | New component (create) |
| `components/drawings/long-press-menu.tsx` | New component (create) |
| `lib/hooks/use-is-mobile.ts` | New hook (create) |
| `components/drawings/drawing-viewer.tsx` | Integrate touch gestures, mobile toolbar, long-press menu |
| `components/drawings/index.ts` | Export new components |

### Acceptance Criteria
- [ ] Pinch gesture zooms in/out smoothly
- [ ] Two-finger drag pans the drawing when zoomed
- [ ] Swipe left/right navigates between sheets
- [ ] Double-tap toggles between fit-to-screen and 100% zoom
- [ ] Long-press shows context menu at touch location
- [ ] Context menu allows creating tasks, RFIs, punch items at location
- [ ] Mobile toolbar appears at bottom on touch devices
- [ ] Toolbar buttons are large enough for easy tapping (48px minimum)
- [ ] Safe area insets respected on iOS devices

---

## Stage 2 Summary

### Components to Create
1. `components/drawings/discipline-tabs.tsx` - Discipline filter tabs
2. `components/drawings/recent-sheets-section.tsx` - Recently viewed sheets
3. `components/drawings/sheet-thumbnail-strip.tsx` - Viewer navigation strip
4. `components/drawings/comparison-viewer.tsx` - Revision comparison
5. `components/drawings/drawing-pin-layer.tsx` - Enhanced pins with clustering
6. `components/drawings/use-touch-gestures.ts` - Touch gesture hook
7. `components/drawings/mobile-drawing-toolbar.tsx` - Mobile action bar
8. `components/drawings/long-press-menu.tsx` - Context menu

### Hooks to Create
1. `lib/hooks/use-is-mobile.ts` - Device detection

### Key Integration Points
1. `drawings-client.tsx` - Add discipline tabs, recent sheets, search bar layout
2. `drawing-viewer.tsx` - Integrate comparison, pins, touch gestures, mobile UI, thumbnail strip

### Testing Checklist
- [ ] Discipline tabs filter correctly and show counts
- [ ] Recent sheets persist in localStorage and display correctly
- [ ] Thumbnail strip shows current sheet highlighted
- [ ] Comparison mode works in all three view types
- [ ] Pin clustering activates at correct zoom threshold
- [ ] Touch gestures work on iPad/iPhone
- [ ] Mobile toolbar is accessible and responsive
- [ ] Long-press creates items at correct drawing location

### Design Philosophy (Non-Tech-Savvy Users)
- Everything visible - no hidden features
- No keyboard shortcuts required (but still available as bonus)
- Search always visible at top
- Tabs instead of tree navigation
- Large touch targets on mobile
- No second sidebar - maximize drawing space

---

*Continue to Stage 3 for Pro Features (measurement tools, revision overlay/diff, offline mode).*
