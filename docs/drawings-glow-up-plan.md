# Drawings Feature Glow-Up Plan

> **Purpose**: Transform the drawings feature into a best-in-class experience for local builders competing with Procore/Buildertrend.
>
> **Philosophy**: Speed, Clarity, Field-First, Smart Defaults

## Table of Contents

- [Stage 1: Quick Wins](#stage-1-quick-wins) - High Impact, Lower Effort
- [Stage 2: Core Improvements](#stage-2-core-improvements) - Navigation & Comparison
- [Stage 3: Pro Features](#stage-3-pro-features) - Advanced Tools
- [Stage 4: Mobile Excellence](#stage-4-mobile-excellence) - Field-First Experience

---

# Stage 1: Quick Wins

**Goal**: Immediate visual and functional improvements that make the feature feel more polished and professional.

**Estimated Scope**: 4 focused improvements

---

## 1.1 Enhanced Sheet Cards with Status Indicators

### Problem
Current sheet cards show basic info (thumbnail, number, title) but don't communicate the "health" of that sheet - are there open issues? Pending RFIs? The user has to click into each sheet to find out.

### Solution
Add visual status indicators to sheet cards showing aggregated item counts and status.

### Design Specification

#### Grid View Card Layout
```
┌─────────────────────────────┐
│  ┌───────────────────────┐  │
│  │                       │  │
│  │      Thumbnail        │  │
│  │       (16:9)          │  │
│  │                       │  │
│  └───────────────────────┘  │
│                             │
│  A-101                      │  ← Sheet number (bold, monospace)
│  First Floor Plan           │  ← Sheet title (truncate with ellipsis)
│                             │
│  ┌─────────────────────────┐│
│  │ 🏗️ Arch  •  Rev B       ││  ← Discipline badge + revision
│  └─────────────────────────┘│
│                             │
│  🔴 3  🟡 2  🟢 5           │  ← Status dots with counts
│                             │
│  [Share ▾]  [•••]           │  ← Quick actions
└─────────────────────────────┘
```

#### Status Dot Meanings
| Dot | Color Hex | Meaning | Source |
|-----|-----------|---------|--------|
| 🔴 | `#EF4444` | Open/Urgent items | Pins with status: `open`, `pending` |
| 🟡 | `#F59E0B` | In Progress items | Pins with status: `in_progress` |
| 🟢 | `#10B981` | Completed items | Pins with status: `closed`, `approved` |
| 🔵 | `#3B82F6` | For Reference | Pins with status: `rejected` or info-only |

#### Hover State
On hover, show tooltip with breakdown:
```
┌────────────────────────┐
│ Open Items (3)         │
│ ├─ 2 Tasks             │
│ ├─ 1 RFI               │
│                        │
│ In Progress (2)        │
│ ├─ 1 Task              │
│ ├─ 1 Punch Item        │
│                        │
│ Completed (5)          │
│ └─ 5 Tasks             │
└────────────────────────┘
```

### Technical Implementation

#### New Service Function: `getSheetStatusCounts`

**File**: `lib/services/drawing-markups.ts`

```typescript
/**
 * Get aggregated pin status counts for multiple sheets
 * Optimized for batch loading in grid/list views
 */
export async function getSheetStatusCounts({
  sheetIds,
  orgId,
}: {
  sheetIds: string[]
  orgId?: string
}): Promise<Record<string, SheetStatusCounts>> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from('drawing_pins')
    .select('drawing_sheet_id, status, entity_type')
    .eq('org_id', resolvedOrgId)
    .in('drawing_sheet_id', sheetIds)

  if (error) throw error

  // Aggregate by sheet
  const counts: Record<string, SheetStatusCounts> = {}

  for (const sheetId of sheetIds) {
    counts[sheetId] = {
      open: 0,
      inProgress: 0,
      completed: 0,
      total: 0,
      byType: {},
      byStatus: {},
    }
  }

  for (const pin of data || []) {
    const sheetCounts = counts[pin.drawing_sheet_id]
    if (!sheetCounts) continue

    sheetCounts.total++

    // Aggregate by status category
    if (['open', 'pending'].includes(pin.status)) {
      sheetCounts.open++
    } else if (pin.status === 'in_progress') {
      sheetCounts.inProgress++
    } else if (['closed', 'approved'].includes(pin.status)) {
      sheetCounts.completed++
    }

    // Detailed breakdowns
    sheetCounts.byType[pin.entity_type] = (sheetCounts.byType[pin.entity_type] || 0) + 1
    sheetCounts.byStatus[pin.status] = (sheetCounts.byStatus[pin.status] || 0) + 1
  }

  return counts
}
```

#### Type Definition

**File**: `lib/services/drawing-markups.ts` (add to types section)

```typescript
export interface SheetStatusCounts {
  open: number
  inProgress: number
  completed: number
  total: number
  byType: Record<string, number>    // e.g., { task: 3, rfi: 1 }
  byStatus: Record<string, number>  // e.g., { open: 2, in_progress: 1 }
}
```

#### Server Action

**File**: `app/drawings/actions.ts`

```typescript
export async function getSheetStatusCountsAction(
  sheetIds: string[]
): Promise<ActionResponse<Record<string, SheetStatusCounts>>> {
  try {
    const counts = await getSheetStatusCounts({ sheetIds })
    return { success: true, data: counts }
  } catch (error) {
    console.error('Failed to get sheet status counts:', error)
    return { success: false, error: 'Failed to load status counts' }
  }
}
```

#### Component: SheetStatusDots

**File**: `components/drawings/sheet-status-dots.tsx`

```typescript
'use client'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { SheetStatusCounts } from '@/lib/services/drawing-markups'

interface SheetStatusDotsProps {
  counts: SheetStatusCounts | null
  size?: 'sm' | 'md'
  showZero?: boolean
}

const STATUS_COLORS = {
  open: 'bg-red-500',
  inProgress: 'bg-yellow-500',
  completed: 'bg-green-500',
} as const

const ENTITY_TYPE_LABELS: Record<string, string> = {
  task: 'Tasks',
  rfi: 'RFIs',
  punch_list: 'Punch Items',
  submittal: 'Submittals',
  daily_log: 'Daily Logs',
  observation: 'Observations',
  issue: 'Issues',
}

export function SheetStatusDots({
  counts,
  size = 'md',
  showZero = false
}: SheetStatusDotsProps) {
  if (!counts || counts.total === 0) {
    if (!showZero) return null
    return (
      <span className="text-xs text-muted-foreground">No items</span>
    )
  }

  const dotSize = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5'
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn('flex items-center gap-3', textSize)}>
          {counts.open > 0 && (
            <div className="flex items-center gap-1">
              <span className={cn('rounded-full', dotSize, STATUS_COLORS.open)} />
              <span className="text-muted-foreground">{counts.open}</span>
            </div>
          )}
          {counts.inProgress > 0 && (
            <div className="flex items-center gap-1">
              <span className={cn('rounded-full', dotSize, STATUS_COLORS.inProgress)} />
              <span className="text-muted-foreground">{counts.inProgress}</span>
            </div>
          )}
          {counts.completed > 0 && (
            <div className="flex items-center gap-1">
              <span className={cn('rounded-full', dotSize, STATUS_COLORS.completed)} />
              <span className="text-muted-foreground">{counts.completed}</span>
            </div>
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="w-48">
        <SheetStatusBreakdown counts={counts} />
      </TooltipContent>
    </Tooltip>
  )
}

function SheetStatusBreakdown({ counts }: { counts: SheetStatusCounts }) {
  const sections = [
    { label: 'Open Items', count: counts.open, status: 'open' },
    { label: 'In Progress', count: counts.inProgress, status: 'inProgress' },
    { label: 'Completed', count: counts.completed, status: 'completed' },
  ].filter(s => s.count > 0)

  return (
    <div className="space-y-2 text-sm">
      {sections.map(section => (
        <div key={section.status}>
          <div className="flex items-center gap-2 font-medium">
            <span className={cn(
              'w-2 h-2 rounded-full',
              STATUS_COLORS[section.status as keyof typeof STATUS_COLORS]
            )} />
            {section.label} ({section.count})
          </div>
          {/* Show type breakdown for this status if available */}
        </div>
      ))}
    </div>
  )
}
```

#### Integration into DrawingsClient

**File**: `components/drawings/drawings-client.tsx`

Changes needed:
1. Add state for status counts: `const [statusCounts, setStatusCounts] = useState<Record<string, SheetStatusCounts>>({})`
2. Fetch counts when sheets load (batch all visible sheet IDs)
3. Pass counts to sheet card components
4. Add `<SheetStatusDots counts={statusCounts[sheet.id]} />` to card render

```typescript
// After sheets are loaded, fetch status counts
useEffect(() => {
  async function loadStatusCounts() {
    if (sheets.length === 0) return
    const sheetIds = sheets.map(s => s.id)
    const result = await getSheetStatusCountsAction(sheetIds)
    if (result.success) {
      setStatusCounts(result.data)
    }
  }
  loadStatusCounts()
}, [sheets])
```

### Files to Modify
| File | Changes |
|------|---------|
| `lib/services/drawing-markups.ts` | Add `getSheetStatusCounts` function and types |
| `app/drawings/actions.ts` | Add `getSheetStatusCountsAction` |
| `components/drawings/sheet-status-dots.tsx` | New component (create) |
| `components/drawings/drawings-client.tsx` | Integrate status dots into grid/list views |
| `components/drawings/index.ts` | Export new component |

### Acceptance Criteria
- [ ] Sheet cards display colored dots with counts for open/in-progress/completed items
- [ ] Hovering shows tooltip with breakdown by item type
- [ ] Sheets with no pins show nothing (clean look) or optional "No items" text
- [ ] Status counts load efficiently (single batch query for all visible sheets)
- [ ] Works in both grid and list view modes

---

## 1.2 Keyboard Shortcuts for Navigation

### Problem
Power users (superintendents reviewing 50+ sheets) waste time clicking. They want to fly through sheets.

### Solution
Add vim-style keyboard navigation throughout the drawings feature.

### Keyboard Shortcut Map

#### Global (Drawings Page)
| Key | Action |
|-----|--------|
| `j` | Move selection down / Next sheet |
| `k` | Move selection up / Previous sheet |
| `Enter` | Open selected sheet in viewer |
| `/` | Focus search input |
| `Escape` | Clear search / Close dialogs |
| `g` then `a` | Filter to Architectural |
| `g` then `s` | Filter to Structural |
| `g` then `m` | Filter to Mechanical |
| `g` then `e` | Filter to Electrical |
| `g` then `p` | Filter to Plumbing |
| `g` then `g` | Clear discipline filter (show all) |
| `v` | Toggle view mode (grid/list) |
| `?` | Show keyboard shortcuts help |

#### Viewer (When Sheet is Open)
| Key | Action |
|-----|--------|
| `h` or `←` | Previous sheet |
| `l` or `→` | Next sheet |
| `+` or `=` | Zoom in |
| `-` | Zoom out |
| `0` | Fit to screen |
| `1` | Zoom to 100% |
| `m` | Toggle markup mode |
| `p` | Toggle pins visibility |
| `d` | Download current sheet |
| `Escape` | Exit viewer / Cancel markup |
| `c` | Toggle comparison mode (Stage 2) |

### Technical Implementation

#### Hook: useDrawingKeyboardShortcuts

**File**: `components/drawings/use-drawing-keyboard-shortcuts.ts`

```typescript
'use client'

import { useEffect, useCallback, useRef } from 'react'

interface KeyboardShortcutHandlers {
  onNextSheet?: () => void
  onPreviousSheet?: () => void
  onOpenSheet?: () => void
  onSearch?: () => void
  onEscape?: () => void
  onFilterDiscipline?: (discipline: string | null) => void
  onToggleView?: () => void
  onZoomIn?: () => void
  onZoomOut?: () => void
  onFitToScreen?: () => void
  onZoom100?: () => void
  onToggleMarkup?: () => void
  onTogglePins?: () => void
  onDownload?: () => void
  onShowHelp?: () => void
}

interface UseDrawingKeyboardShortcutsOptions {
  enabled?: boolean
  context: 'list' | 'viewer'
  handlers: KeyboardShortcutHandlers
}

const DISCIPLINE_KEYS: Record<string, string> = {
  'a': 'A',  // Architectural
  's': 'S',  // Structural
  'm': 'M',  // Mechanical
  'e': 'E',  // Electrical
  'p': 'P',  // Plumbing
  'c': 'C',  // Civil
  'l': 'L',  // Landscape
  'f': 'FP', // Fire Protection
  'g': null, // Clear filter (show all)
}

export function useDrawingKeyboardShortcuts({
  enabled = true,
  context,
  handlers,
}: UseDrawingKeyboardShortcutsOptions) {
  const pendingGoto = useRef(false)
  const pendingGotoTimeout = useRef<NodeJS.Timeout>()

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    // Don't trigger shortcuts when typing in inputs
    const target = event.target as HTMLElement
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    ) {
      // Allow Escape to blur inputs
      if (event.key === 'Escape') {
        target.blur()
        handlers.onEscape?.()
      }
      return
    }

    const key = event.key.toLowerCase()

    // Handle "g then X" sequences for discipline filtering
    if (pendingGoto.current) {
      pendingGoto.current = false
      clearTimeout(pendingGotoTimeout.current)

      if (key in DISCIPLINE_KEYS) {
        event.preventDefault()
        handlers.onFilterDiscipline?.(DISCIPLINE_KEYS[key])
        return
      }
    }

    // Start "g" sequence
    if (key === 'g' && !event.metaKey && !event.ctrlKey) {
      pendingGoto.current = true
      // Reset after 1 second if no follow-up key
      pendingGotoTimeout.current = setTimeout(() => {
        pendingGoto.current = false
      }, 1000)
      return
    }

    // Prevent default for our shortcuts
    const handled = handleShortcut(key, event, context, handlers)
    if (handled) {
      event.preventDefault()
    }
  }, [context, handlers])

  useEffect(() => {
    if (!enabled) return

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      clearTimeout(pendingGotoTimeout.current)
    }
  }, [enabled, handleKeyDown])
}

function handleShortcut(
  key: string,
  event: KeyboardEvent,
  context: 'list' | 'viewer',
  handlers: KeyboardShortcutHandlers
): boolean {
  // Universal shortcuts
  switch (key) {
    case 'escape':
      handlers.onEscape?.()
      return true
    case '?':
      if (event.shiftKey) {
        handlers.onShowHelp?.()
        return true
      }
      break
    case '/':
      handlers.onSearch?.()
      return true
  }

  // Context-specific shortcuts
  if (context === 'list') {
    switch (key) {
      case 'j':
        handlers.onNextSheet?.()
        return true
      case 'k':
        handlers.onPreviousSheet?.()
        return true
      case 'enter':
        handlers.onOpenSheet?.()
        return true
      case 'v':
        handlers.onToggleView?.()
        return true
    }
  }

  if (context === 'viewer') {
    switch (key) {
      case 'h':
      case 'arrowleft':
        handlers.onPreviousSheet?.()
        return true
      case 'l':
      case 'arrowright':
        handlers.onNextSheet?.()
        return true
      case '+':
      case '=':
        handlers.onZoomIn?.()
        return true
      case '-':
        handlers.onZoomOut?.()
        return true
      case '0':
        handlers.onFitToScreen?.()
        return true
      case '1':
        handlers.onZoom100?.()
        return true
      case 'm':
        handlers.onToggleMarkup?.()
        return true
      case 'p':
        handlers.onTogglePins?.()
        return true
      case 'd':
        handlers.onDownload?.()
        return true
    }
  }

  return false
}
```

#### Component: KeyboardShortcutsHelp

**File**: `components/drawings/keyboard-shortcuts-help.tsx`

```typescript
'use client'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface KeyboardShortcutsHelpProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: 'list' | 'viewer'
}

const LIST_SHORTCUTS = [
  { keys: ['j'], description: 'Next sheet' },
  { keys: ['k'], description: 'Previous sheet' },
  { keys: ['Enter'], description: 'Open selected sheet' },
  { keys: ['/'], description: 'Search sheets' },
  { keys: ['v'], description: 'Toggle grid/list view' },
  { keys: ['g', 'a'], description: 'Filter: Architectural' },
  { keys: ['g', 's'], description: 'Filter: Structural' },
  { keys: ['g', 'm'], description: 'Filter: Mechanical' },
  { keys: ['g', 'e'], description: 'Filter: Electrical' },
  { keys: ['g', 'p'], description: 'Filter: Plumbing' },
  { keys: ['g', 'g'], description: 'Clear filter (show all)' },
  { keys: ['Esc'], description: 'Clear search' },
  { keys: ['?'], description: 'Show this help' },
]

const VIEWER_SHORTCUTS = [
  { keys: ['h', '←'], description: 'Previous sheet' },
  { keys: ['l', '→'], description: 'Next sheet' },
  { keys: ['+'], description: 'Zoom in' },
  { keys: ['-'], description: 'Zoom out' },
  { keys: ['0'], description: 'Fit to screen' },
  { keys: ['1'], description: 'Zoom to 100%' },
  { keys: ['m'], description: 'Toggle markup mode' },
  { keys: ['p'], description: 'Toggle pins' },
  { keys: ['d'], description: 'Download sheet' },
  { keys: ['Esc'], description: 'Close viewer' },
]

export function KeyboardShortcutsHelp({
  open,
  onOpenChange,
  context,
}: KeyboardShortcutsHelpProps) {
  const shortcuts = context === 'list' ? LIST_SHORTCUTS : VIEWER_SHORTCUTS

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          {shortcuts.map((shortcut, i) => (
            <div
              key={i}
              className="flex items-center justify-between py-1"
            >
              <span className="text-sm text-muted-foreground">
                {shortcut.description}
              </span>
              <div className="flex gap-1">
                {shortcut.keys.map((key, j) => (
                  <span key={j}>
                    <kbd className="px-2 py-1 text-xs font-semibold bg-muted rounded border">
                      {key}
                    </kbd>
                    {j < shortcut.keys.length - 1 && (
                      <span className="mx-1 text-muted-foreground">then</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

#### Integration Points

**File**: `components/drawings/drawings-client.tsx`

```typescript
// Add state for selected index and help dialog
const [selectedIndex, setSelectedIndex] = useState(0)
const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)
const searchInputRef = useRef<HTMLInputElement>(null)

// Use the keyboard shortcuts hook
useDrawingKeyboardShortcuts({
  enabled: !viewerOpen, // Disable list shortcuts when viewer is open
  context: 'list',
  handlers: {
    onNextSheet: () => setSelectedIndex(i => Math.min(i + 1, sheets.length - 1)),
    onPreviousSheet: () => setSelectedIndex(i => Math.max(i - 1, 0)),
    onOpenSheet: () => {
      const sheet = sheets[selectedIndex]
      if (sheet) openViewer(sheet)
    },
    onSearch: () => searchInputRef.current?.focus(),
    onEscape: () => {
      setSearch('')
      searchInputRef.current?.blur()
    },
    onFilterDiscipline: setDisciplineFilter,
    onToggleView: () => setViewMode(v => v === 'grid' ? 'list' : 'grid'),
    onShowHelp: () => setShowShortcutsHelp(true),
  },
})

// Add visual selection indicator to sheet cards
// In grid view, add ring to selected card
// In list view, add background highlight to selected row
```

### Files to Create/Modify
| File | Changes |
|------|---------|
| `components/drawings/use-drawing-keyboard-shortcuts.ts` | New hook (create) |
| `components/drawings/keyboard-shortcuts-help.tsx` | New component (create) |
| `components/drawings/drawings-client.tsx` | Integrate hook, add selection state |
| `components/drawings/drawing-viewer.tsx` | Integrate hook for viewer context |
| `components/drawings/index.ts` | Export new components |

### Acceptance Criteria
- [ ] `j`/`k` navigate through sheets in list/grid view with visual selection
- [ ] `Enter` opens selected sheet
- [ ] `/` focuses search input
- [ ] `g` then discipline letter filters instantly
- [ ] `?` shows help dialog with all shortcuts
- [ ] Shortcuts work in viewer (h/l for prev/next, +/- for zoom)
- [ ] Shortcuts are disabled when typing in inputs
- [ ] Selection persists when filtering/searching

---

## 1.3 Auto-Discipline Detection from Sheet Numbers

### Problem
Users upload a 50-sheet PDF. All sheets are marked as "Unknown" discipline. They have to manually classify each one, which is tedious and error-prone.

### Solution
Parse sheet numbers during processing to auto-detect discipline. Standard construction sheet numbering follows patterns like `A-101`, `S-200`, `M-001`.

### Discipline Detection Rules

#### Primary Prefix Patterns
| Pattern | Discipline | Code |
|---------|------------|------|
| `A-`, `A1`, `AD-`, `ARCH-` | Architectural | `A` |
| `S-`, `S1`, `SD-`, `STR-` | Structural | `S` |
| `M-`, `M1`, `MECH-`, `HVAC-` | Mechanical | `M` |
| `E-`, `E1`, `EL-`, `ELEC-` | Electrical | `E` |
| `P-`, `P1`, `PL-`, `PLMB-` | Plumbing | `P` |
| `FP-`, `FS-`, `FIRE-` | Fire Protection | `FP` |
| `C-`, `C1`, `CIV-`, `CIVIL-` | Civil | `C` |
| `L-`, `L1`, `LA-`, `LAND-` | Landscape | `L` |
| `I-`, `I1`, `ID-`, `INT-` | Interior | `I` |
| `G-`, `G0`, `GEN-`, `T-` | General/Title | `G` |
| `SP-`, `SPEC-` | Specifications | `SP` |
| `D-`, `DT-`, `DTL-` | Details | `D` |

#### Detection Algorithm

```typescript
const DISCIPLINE_PATTERNS: Array<{ pattern: RegExp; discipline: DrawingDiscipline }> = [
  // Architectural
  { pattern: /^A[D]?[-.]?\d/i, discipline: 'A' },
  { pattern: /^ARCH/i, discipline: 'A' },

  // Structural
  { pattern: /^S[D]?[-.]?\d/i, discipline: 'S' },
  { pattern: /^STR/i, discipline: 'S' },

  // Mechanical
  { pattern: /^M[-.]?\d/i, discipline: 'M' },
  { pattern: /^MECH/i, discipline: 'M' },
  { pattern: /^HVAC/i, discipline: 'M' },

  // Electrical
  { pattern: /^E[L]?[-.]?\d/i, discipline: 'E' },
  { pattern: /^ELEC/i, discipline: 'E' },

  // Plumbing
  { pattern: /^P[L]?[-.]?\d/i, discipline: 'P' },
  { pattern: /^PLMB/i, discipline: 'P' },
  { pattern: /^PLUM/i, discipline: 'P' },

  // Fire Protection
  { pattern: /^F[PS][-.]?\d/i, discipline: 'FP' },
  { pattern: /^FIRE/i, discipline: 'FP' },

  // Civil
  { pattern: /^C[V]?[-.]?\d/i, discipline: 'C' },
  { pattern: /^CIV/i, discipline: 'C' },

  // Landscape
  { pattern: /^L[A]?[-.]?\d/i, discipline: 'L' },
  { pattern: /^LAND/i, discipline: 'L' },

  // Interior
  { pattern: /^I[D]?[-.]?\d/i, discipline: 'I' },
  { pattern: /^INT/i, discipline: 'I' },

  // General/Title
  { pattern: /^G[-.]?\d/i, discipline: 'G' },
  { pattern: /^T[-.]?\d/i, discipline: 'T' },
  { pattern: /^GEN/i, discipline: 'G' },

  // Specifications
  { pattern: /^SP[-.]?\d/i, discipline: 'SP' },
  { pattern: /^SPEC/i, discipline: 'SP' },

  // Details
  { pattern: /^D[T]?[-.]?\d/i, discipline: 'D' },
  { pattern: /^DTL/i, discipline: 'D' },
]

export function detectDiscipline(sheetNumber: string): DrawingDiscipline {
  const normalized = sheetNumber.trim().toUpperCase()

  for (const { pattern, discipline } of DISCIPLINE_PATTERNS) {
    if (pattern.test(normalized)) {
      return discipline
    }
  }

  return 'X' // Unknown/Other
}
```

### Technical Implementation

#### Utility Function

**File**: `lib/utils/drawing-utils.ts` (create new file)

```typescript
import type { DrawingDiscipline } from '@/lib/validation/drawings'

const DISCIPLINE_PATTERNS: Array<{ pattern: RegExp; discipline: DrawingDiscipline }> = [
  // Architectural - most common, check first
  { pattern: /^A[D]?[-./]?\d/i, discipline: 'A' },
  { pattern: /^ARCH/i, discipline: 'A' },

  // Structural
  { pattern: /^S[D]?[-./]?\d/i, discipline: 'S' },
  { pattern: /^STR/i, discipline: 'S' },

  // Mechanical
  { pattern: /^M[-./]?\d/i, discipline: 'M' },
  { pattern: /^MECH/i, discipline: 'M' },
  { pattern: /^HVAC/i, discipline: 'M' },

  // Electrical
  { pattern: /^E[L]?[-./]?\d/i, discipline: 'E' },
  { pattern: /^ELEC/i, discipline: 'E' },

  // Plumbing
  { pattern: /^P[L]?[-./]?\d/i, discipline: 'P' },
  { pattern: /^PLMB/i, discipline: 'P' },
  { pattern: /^PLUM/i, discipline: 'P' },

  // Fire Protection
  { pattern: /^F[PS][-./]?\d/i, discipline: 'FP' },
  { pattern: /^FIRE/i, discipline: 'FP' },

  // Civil
  { pattern: /^C[IV]?[-./]?\d/i, discipline: 'C' },
  { pattern: /^CIV/i, discipline: 'C' },

  // Landscape
  { pattern: /^L[A]?[-./]?\d/i, discipline: 'L' },
  { pattern: /^LAND/i, discipline: 'L' },

  // Interior
  { pattern: /^I[D]?[-./]?\d/i, discipline: 'I' },
  { pattern: /^INT/i, discipline: 'I' },

  // General/Title/Cover
  { pattern: /^G[-./]?\d/i, discipline: 'G' },
  { pattern: /^T[-./]?\d/i, discipline: 'T' },
  { pattern: /^GEN/i, discipline: 'G' },
  { pattern: /^COVER/i, discipline: 'T' },
  { pattern: /^TITLE/i, discipline: 'T' },

  // Specifications
  { pattern: /^SP[-./]?\d/i, discipline: 'SP' },
  { pattern: /^SPEC/i, discipline: 'SP' },

  // Details
  { pattern: /^D[T]?[-./]?\d/i, discipline: 'D' },
  { pattern: /^DTL/i, discipline: 'D' },
  { pattern: /^DET/i, discipline: 'D' },
]

/**
 * Detect the discipline of a drawing sheet based on its sheet number.
 * Uses standard construction industry naming conventions.
 *
 * @example
 * detectDiscipline('A-101')  // 'A' (Architectural)
 * detectDiscipline('S.200')  // 'S' (Structural)
 * detectDiscipline('M001')   // 'M' (Mechanical)
 * detectDiscipline('ELEC-1') // 'E' (Electrical)
 * detectDiscipline('random') // 'X' (Unknown)
 */
export function detectDiscipline(sheetNumber: string): DrawingDiscipline {
  if (!sheetNumber) return 'X'

  const normalized = sheetNumber.trim().toUpperCase()

  for (const { pattern, discipline } of DISCIPLINE_PATTERNS) {
    if (pattern.test(normalized)) {
      return discipline
    }
  }

  return 'X' // Unknown/Other
}

/**
 * Parse a sheet number into its components.
 *
 * @example
 * parseSheetNumber('A-101')
 * // { prefix: 'A', separator: '-', number: '101', suffix: '' }
 *
 * parseSheetNumber('A-101a')
 * // { prefix: 'A', separator: '-', number: '101', suffix: 'a' }
 */
export function parseSheetNumber(sheetNumber: string): {
  prefix: string
  separator: string
  number: string
  suffix: string
  discipline: DrawingDiscipline
} {
  const match = sheetNumber.match(/^([A-Za-z]+)([-./]?)(\d+)([A-Za-z]*)$/)

  if (!match) {
    return {
      prefix: '',
      separator: '',
      number: sheetNumber,
      suffix: '',
      discipline: 'X',
    }
  }

  const [, prefix, separator, number, suffix] = match

  return {
    prefix: prefix.toUpperCase(),
    separator,
    number,
    suffix: suffix.toLowerCase(),
    discipline: detectDiscipline(sheetNumber),
  }
}

/**
 * Sort sheet numbers in natural order.
 * A-001, A-002, ..., A-010, A-011, ..., A-100
 * Then by discipline: A before S before M, etc.
 */
export function sortSheetNumbers(a: string, b: string): number {
  const parsedA = parseSheetNumber(a)
  const parsedB = parseSheetNumber(b)

  // First sort by discipline
  const disciplineOrder = ['G', 'T', 'A', 'S', 'M', 'E', 'P', 'FP', 'C', 'L', 'I', 'SP', 'D', 'X']
  const disciplineCompare =
    disciplineOrder.indexOf(parsedA.discipline) -
    disciplineOrder.indexOf(parsedB.discipline)

  if (disciplineCompare !== 0) return disciplineCompare

  // Then by number (numeric sort)
  const numA = parseInt(parsedA.number, 10) || 0
  const numB = parseInt(parsedB.number, 10) || 0

  if (numA !== numB) return numA - numB

  // Then by suffix
  return parsedA.suffix.localeCompare(parsedB.suffix)
}

/**
 * Get the discipline label for display.
 */
export const DISCIPLINE_LABELS: Record<DrawingDiscipline, string> = {
  A: 'Architectural',
  S: 'Structural',
  M: 'Mechanical',
  E: 'Electrical',
  P: 'Plumbing',
  FP: 'Fire Protection',
  C: 'Civil',
  L: 'Landscape',
  I: 'Interior',
  G: 'General',
  T: 'Title/Cover',
  SP: 'Specifications',
  D: 'Details',
  X: 'Other',
}

/**
 * Get a short discipline label (for badges).
 */
export const DISCIPLINE_SHORT_LABELS: Record<DrawingDiscipline, string> = {
  A: 'Arch',
  S: 'Struct',
  M: 'Mech',
  E: 'Elec',
  P: 'Plumb',
  FP: 'Fire',
  C: 'Civil',
  L: 'Land',
  I: 'Int',
  G: 'Gen',
  T: 'Title',
  SP: 'Spec',
  D: 'Detail',
  X: 'Other',
}
```

#### Edge Function Update

The edge function `process-drawing-set` needs to be updated to call `detectDiscipline` when creating sheets.

**File**: `supabase/functions/process-drawing-set/index.ts`

```typescript
// When creating a sheet from an extracted page:
import { detectDiscipline } from './utils/drawing-utils'

// ... in the page processing loop:
const sheetNumber = extractedSheetNumber || `Page-${pageIndex + 1}`
const discipline = detectDiscipline(sheetNumber)

await supabase.from('drawing_sheets').insert({
  org_id: orgId,
  project_id: projectId,
  drawing_set_id: drawingSetId,
  sheet_number: sheetNumber,
  sheet_title: extractedTitle || `Sheet ${pageIndex + 1}`,
  discipline: discipline, // Auto-detected!
  sort_order: pageIndex,
  // ... other fields
})
```

#### Update Service for Manual Override

Users should still be able to manually change discipline if auto-detection is wrong.

**File**: `lib/services/drawings.ts`

Already has `updateDrawingSheet` which accepts `discipline` - no changes needed.

### Files to Create/Modify
| File | Changes |
|------|---------|
| `lib/utils/drawing-utils.ts` | New utility file with detection logic |
| `supabase/functions/process-drawing-set/index.ts` | Call detectDiscipline during processing |
| `components/drawings/drawings-client.tsx` | Show detected discipline, allow override |

### Acceptance Criteria
- [ ] Uploading a PDF with sheets named A-101, S-200, etc. auto-assigns disciplines
- [ ] Unknown patterns fall back to 'X' (Other)
- [ ] Users can manually override auto-detected discipline
- [ ] Detection works with various separators: `-`, `.`, `/`, or none
- [ ] Case-insensitive detection (a-101 and A-101 both work)
- [ ] Sheets are sorted by discipline, then by number

---

## 1.4 Improved Upload Preview with Detected Sheets

### Problem
Current upload flow: select file → wait for processing → hope it worked. No preview, no control over naming, no visibility into what's being created.

### Solution
After upload but before (or during) processing, show a preview of detected sheets with the ability to edit names and disciplines before finalizing.

### Design Specification

#### Upload States

**State 1: Initial Upload Zone**
```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                    📄 Upload Plan Set                       │
│                                                             │
│     Drag and drop your PDF here, or click to browse         │
│                                                             │
│     ───────────────────────────────────────────────────     │
│                                                             │
│     Supports multi-page PDFs up to 200 pages               │
│     Each page will become a separate sheet                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**State 2: Processing Preview**
```
┌─────────────────────────────────────────────────────────────┐
│  📄 2024-12-Construction-Documents.pdf                      │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 67%              │
│  Processing page 34 of 51...                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Detected Sheets Preview                                    │
│                                                             │
│  ▼ Architectural (23 sheets)                                │
│    ┌─────┐ A-001  Cover Sheet               [Edit]         │
│    │ 📄  │ A-101  First Floor Plan          [Edit]         │
│    └─────┘ A-102  Second Floor Plan         [Edit]         │
│           ...                                               │
│                                                             │
│  ▼ Structural (8 sheets)                                    │
│    ┌─────┐ S-001  Foundation Plan           [Edit]         │
│    │ 📄  │ S-101  First Floor Framing       [Edit]         │
│    └─────┘ ...                                              │
│                                                             │
│  ▼ Mechanical (6 sheets)                                    │
│    ...                                                      │
│                                                             │
│  ▶ Electrical (5 sheets)  [collapsed]                       │
│  ▶ Plumbing (5 sheets)    [collapsed]                       │
│  ▶ Unknown (4 sheets)     [collapsed]                       │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Set Title: [December 2024 CD Set_____________]             │
│                                                             │
│  Revision:  [Rev B ▼] or [+ New Revision]                   │
│                                                             │
│            [Cancel]                    [Accept & Finalize]  │
└─────────────────────────────────────────────────────────────┘
```

**State 3: Edit Sheet Dialog**
```
┌─────────────────────────────────────────────┐
│  Edit Sheet                          [×]    │
├─────────────────────────────────────────────┤
│                                             │
│  Sheet Number                               │
│  [A-101________________________]            │
│                                             │
│  Sheet Title                                │
│  [First Floor Plan______________]           │
│                                             │
│  Discipline                                 │
│  [Architectural ▼]                          │
│                                             │
│  Preview                                    │
│  ┌───────────────────────────────┐          │
│  │                               │          │
│  │      [Thumbnail Preview]      │          │
│  │                               │          │
│  └───────────────────────────────┘          │
│                                             │
│         [Cancel]        [Save Changes]      │
└─────────────────────────────────────────────┘
```

### Technical Implementation

#### Component: UploadPreviewDialog

**File**: `components/drawings/upload-preview-dialog.tsx`

```typescript
'use client'

import { useState, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { ChevronRight, ChevronDown, Pencil } from 'lucide-react'
import { detectDiscipline, DISCIPLINE_LABELS } from '@/lib/utils/drawing-utils'
import type { DrawingDiscipline } from '@/lib/validation/drawings'

interface DetectedSheet {
  pageIndex: number
  sheetNumber: string
  sheetTitle: string
  discipline: DrawingDiscipline
  thumbnailUrl?: string
}

interface UploadPreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fileName: string
  processingProgress: number  // 0-100
  totalPages: number
  processedPages: number
  detectedSheets: DetectedSheet[]
  onUpdateSheet: (pageIndex: number, updates: Partial<DetectedSheet>) => void
  onAccept: (setTitle: string, revisionLabel: string) => void
  onCancel: () => void
}

export function UploadPreviewDialog({
  open,
  onOpenChange,
  fileName,
  processingProgress,
  totalPages,
  processedPages,
  detectedSheets,
  onUpdateSheet,
  onAccept,
  onCancel,
}: UploadPreviewDialogProps) {
  const [setTitle, setSetTitle] = useState(
    fileName.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ')
  )
  const [revisionLabel, setRevisionLabel] = useState('Rev A')
  const [editingSheet, setEditingSheet] = useState<DetectedSheet | null>(null)
  const [expandedDisciplines, setExpandedDisciplines] = useState<Set<string>>(
    new Set(['A', 'S', 'M', 'E', 'P']) // Expand common ones by default
  )

  // Group sheets by discipline
  const sheetsByDiscipline = useMemo(() => {
    const groups: Record<string, DetectedSheet[]> = {}

    for (const sheet of detectedSheets) {
      const disc = sheet.discipline
      if (!groups[disc]) groups[disc] = []
      groups[disc].push(sheet)
    }

    // Sort disciplines by standard order
    const order = ['G', 'T', 'A', 'S', 'M', 'E', 'P', 'FP', 'C', 'L', 'I', 'SP', 'D', 'X']
    return Object.entries(groups).sort(
      ([a], [b]) => order.indexOf(a) - order.indexOf(b)
    )
  }, [detectedSheets])

  const toggleDiscipline = (disc: string) => {
    setExpandedDisciplines(prev => {
      const next = new Set(prev)
      if (next.has(disc)) {
        next.delete(disc)
      } else {
        next.add(disc)
      }
      return next
    })
  }

  const isProcessing = processingProgress < 100

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Upload Plan Set</DialogTitle>
        </DialogHeader>

        {/* Progress Section */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium truncate">{fileName}</span>
            <span className="text-muted-foreground">
              {isProcessing ? `Processing ${processedPages} of ${totalPages}...` : 'Complete'}
            </span>
          </div>
          <Progress value={processingProgress} />
        </div>

        {/* Sheets Preview */}
        <div className="flex-1 overflow-y-auto border rounded-lg">
          <div className="p-3 border-b bg-muted/50">
            <span className="text-sm font-medium">
              Detected {detectedSheets.length} sheets
            </span>
          </div>

          <div className="divide-y">
            {sheetsByDiscipline.map(([discipline, sheets]) => (
              <Collapsible
                key={discipline}
                open={expandedDisciplines.has(discipline)}
                onOpenChange={() => toggleDiscipline(discipline)}
              >
                <CollapsibleTrigger className="flex items-center gap-2 w-full p-3 hover:bg-muted/50 transition-colors">
                  {expandedDisciplines.has(discipline) ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  <span className="font-medium">
                    {DISCIPLINE_LABELS[discipline as DrawingDiscipline]}
                  </span>
                  <span className="text-muted-foreground">
                    ({sheets.length} sheets)
                  </span>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <div className="pl-9 pr-3 pb-2 space-y-1">
                    {sheets.map(sheet => (
                      <div
                        key={sheet.pageIndex}
                        className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 group"
                      >
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sm w-16">
                            {sheet.sheetNumber}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            {sheet.sheetTitle}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => setEditingSheet(sheet)}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        </div>

        {/* Set Metadata */}
        <div className="grid grid-cols-2 gap-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="setTitle">Set Title</Label>
            <Input
              id="setTitle"
              value={setTitle}
              onChange={(e) => setSetTitle(e.target.value)}
              placeholder="e.g., December 2024 CD Set"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="revision">Revision</Label>
            <Input
              id="revision"
              value={revisionLabel}
              onChange={(e) => setRevisionLabel(e.target.value)}
              placeholder="e.g., Rev A, For Construction"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={() => onAccept(setTitle, revisionLabel)}
            disabled={isProcessing}
          >
            {isProcessing ? 'Processing...' : 'Accept & Finalize'}
          </Button>
        </DialogFooter>

        {/* Edit Sheet Dialog */}
        {editingSheet && (
          <EditSheetDialog
            sheet={editingSheet}
            onSave={(updates) => {
              onUpdateSheet(editingSheet.pageIndex, updates)
              setEditingSheet(null)
            }}
            onCancel={() => setEditingSheet(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface EditSheetDialogProps {
  sheet: DetectedSheet
  onSave: (updates: Partial<DetectedSheet>) => void
  onCancel: () => void
}

function EditSheetDialog({ sheet, onSave, onCancel }: EditSheetDialogProps) {
  const [sheetNumber, setSheetNumber] = useState(sheet.sheetNumber)
  const [sheetTitle, setSheetTitle] = useState(sheet.sheetTitle)
  const [discipline, setDiscipline] = useState(sheet.discipline)

  // Auto-update discipline when sheet number changes
  const handleSheetNumberChange = (value: string) => {
    setSheetNumber(value)
    const detected = detectDiscipline(value)
    if (detected !== 'X') {
      setDiscipline(detected)
    }
  }

  return (
    <Dialog open onOpenChange={() => onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Sheet</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sheetNumber">Sheet Number</Label>
            <Input
              id="sheetNumber"
              value={sheetNumber}
              onChange={(e) => handleSheetNumberChange(e.target.value)}
              placeholder="e.g., A-101"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sheetTitle">Sheet Title</Label>
            <Input
              id="sheetTitle"
              value={sheetTitle}
              onChange={(e) => setSheetTitle(e.target.value)}
              placeholder="e.g., First Floor Plan"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="discipline">Discipline</Label>
            <select
              id="discipline"
              value={discipline}
              onChange={(e) => setDiscipline(e.target.value as DrawingDiscipline)}
              className="w-full h-10 px-3 rounded-md border border-input bg-background"
            >
              {Object.entries(DISCIPLINE_LABELS).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {sheet.thumbnailUrl && (
            <div className="space-y-2">
              <Label>Preview</Label>
              <div className="border rounded-lg overflow-hidden bg-muted">
                <img
                  src={sheet.thumbnailUrl}
                  alt={`Preview of ${sheetNumber}`}
                  className="w-full h-auto"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onSave({ sheetNumber, sheetTitle, discipline })}>
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

### Updated Upload Flow

The upload flow needs to be modified to show the preview dialog during processing:

1. User selects PDF file
2. File is uploaded to storage
3. Processing starts
4. Preview dialog opens immediately
5. As pages are processed, they appear in the preview grouped by discipline
6. User can edit sheet names/disciplines while processing continues
7. When done, user clicks "Accept & Finalize"
8. Any edits are applied to the created sheets

### Files to Create/Modify
| File | Changes |
|------|---------|
| `components/drawings/upload-preview-dialog.tsx` | New component (create) |
| `components/drawings/drawings-client.tsx` | Replace simple upload with preview flow |
| `app/drawings/actions.ts` | Add action to update sheet metadata before finalizing |
| `lib/utils/drawing-utils.ts` | Ensure exports are available |
| `components/drawings/index.ts` | Export new component |

### Acceptance Criteria
- [ ] Upload shows progress bar with page count
- [ ] Detected sheets appear grouped by discipline as processing progresses
- [ ] Users can edit sheet number, title, and discipline before finalizing
- [ ] Changing sheet number auto-updates discipline detection
- [ ] Set title defaults to filename (cleaned up)
- [ ] Revision label can be set during upload
- [ ] "Accept & Finalize" saves all edits
- [ ] Cancel aborts the upload and cleans up partial data

---

## Stage 1 Summary

### Components to Create
1. `components/drawings/sheet-status-dots.tsx` - Status indicators
2. `components/drawings/use-drawing-keyboard-shortcuts.ts` - Keyboard hook
3. `components/drawings/keyboard-shortcuts-help.tsx` - Help dialog
4. `lib/utils/drawing-utils.ts` - Discipline detection utilities
5. `components/drawings/upload-preview-dialog.tsx` - Upload preview

### Services to Update
1. `lib/services/drawing-markups.ts` - Add `getSheetStatusCounts`

### Actions to Add
1. `getSheetStatusCountsAction` - Batch status counts
2. Update upload flow for preview support

### Testing Checklist
- [ ] Status dots show correctly on sheet cards
- [ ] Keyboard shortcuts work in list and viewer contexts
- [ ] Discipline detection works for all standard patterns
- [ ] Upload preview shows sheets grouped by discipline
- [ ] Edits in upload preview are persisted

---

*Continue to Stage 2 for Navigation & Comparison features.*
