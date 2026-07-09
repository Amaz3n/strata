"use client"

import { type ReactNode } from "react"
import { ArrowLeft, Search } from "lucide-react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

export interface WorkspaceQueue<K extends string> {
  key: K
  label: string
  count: number
}

interface WorkspaceListPanelProps<T, K extends string> {
  /** Title shown next to the back button. */
  title: string
  /** Called when the back button is pressed. */
  onBack: () => void
  search: string
  onSearchChange: (value: string) => void
  searchPlaceholder?: string
  /** Up to ~4 queue filter chips. */
  queues: WorkspaceQueue<K>[]
  activeQueue: K
  onQueueChange: (key: K) => void
  items: T[]
  getKey: (item: T) => string
  isActive: (item: T) => boolean
  onSelect: (item: T) => void
  renderRow: (item: T, active: boolean) => ReactNode
  emptyLabel?: string
}

/**
 * Generic left list panel for a WorkspaceShell: back header, search box, queue chip
 * grid, and a scrollable list of selectable rows. Row content is fully delegated to
 * `renderRow` so each domain controls its own layout.
 */
export function WorkspaceListPanel<T, K extends string>({
  title,
  onBack,
  search,
  onSearchChange,
  searchPlaceholder = "Search...",
  queues,
  activeQueue,
  onQueueChange,
  items,
  getKey,
  isActive,
  onSelect,
  renderRow,
  emptyLabel = "No matches.",
}: WorkspaceListPanelProps<T, K>) {
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="group flex h-16 w-full shrink-0 items-center gap-2 border-b px-4 text-left transition-colors hover:bg-muted/50"
        title={`Back to ${title.toLowerCase()}`}
      >
        <ArrowLeft className="h-4 w-4 text-muted-foreground transition-transform group-hover:-translate-x-0.5" />
        <span className="text-sm font-semibold">{title}</span>
      </button>

      <div className="border-b px-3 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-9 pl-8"
          />
        </div>
        <div
          className="mt-2 grid gap-1"
          style={{ gridTemplateColumns: `repeat(${Math.min(queues.length, 3)}, minmax(0, 1fr))` }}
        >
          {queues.map((queue) => (
            <button
              key={queue.key}
              type="button"
              onClick={() => onQueueChange(queue.key)}
              className={cn(
                "flex items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors",
                activeQueue === queue.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {queue.label}
              <span className="tabular-nums opacity-70">{queue.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {items.map((item) => {
          const active = isActive(item)
          return (
            <button
              key={getKey(item)}
              type="button"
              onClick={() => onSelect(item)}
              className={cn(
                "flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left transition-colors",
                active ? "bg-primary/10" : "hover:bg-muted/50",
              )}
            >
              {renderRow(item, active)}
            </button>
          )
        })}
        {items.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">{emptyLabel}</div>
        ) : null}
      </div>
    </>
  )
}
