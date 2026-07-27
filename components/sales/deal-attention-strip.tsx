"use client"

import type { ComponentType } from "react"

import { Bell, Clock, FileText, Home, UserPlus } from "@/components/icons"
import { DEAL_FILTER_LABELS, type DealFilter } from "@/lib/sales/next-action"
import { cn } from "@/lib/utils"

interface AttentionItem {
  key: Exclude<DealFilter, "all">
  icon: ComponentType<{ className?: string }>
  /** Token-only tones: colour here means urgency, matching the row spine. */
  tone: string
}

const ITEMS: AttentionItem[] = [
  { key: "followup_due", icon: Bell, tone: "border-destructive/40 bg-destructive/10 text-destructive" },
  { key: "hold_expiring", icon: Clock, tone: "border-warning/40 bg-warning/10 text-warning" },
  { key: "out_for_signature", icon: FileText, tone: "border-chart-1/40 bg-chart-1/10 text-chart-1" },
  { key: "closing_soon", icon: Home, tone: "border-success/40 bg-success/10 text-success" },
  { key: "new_inquiries", icon: UserPlus, tone: "border-chart-2/40 bg-chart-2/10 text-chart-2" },
]

/**
 * What needs attention, as pills that disappear when they are empty. A row of
 * zeroes is noise a consultant learns to skip; a strip that is short on a good
 * morning and long on a bad one is read every time.
 */
export function DealAttentionStrip({
  counts,
  activeFilter,
  onSelect,
}: {
  counts: Record<DealFilter, number>
  activeFilter: DealFilter
  onSelect: (filter: DealFilter) => void
}) {
  const visible = ITEMS.filter((item) => counts[item.key] > 0)
  if (visible.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible.map((item) => {
        const Icon = item.icon
        const active = activeFilter === item.key
        return (
          <button
            key={item.key}
            type="button"
            // Clicking the active pill clears it, so the strip never traps you
            // in a filter you have to hunt for a way out of.
            onClick={() => onSelect(active ? "all" : item.key)}
            aria-pressed={active}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 border px-2 py-1 text-xs transition-all",
              item.tone,
              active ? "ring-1 ring-current/40" : "opacity-85 hover:opacity-100",
            )}
          >
            <Icon className="size-3.5" />
            <span className="font-semibold tabular-nums">{counts[item.key]}</span>
            <span className="font-normal whitespace-nowrap">{DEAL_FILTER_LABELS[item.key]}</span>
          </button>
        )
      })}
    </div>
  )
}
