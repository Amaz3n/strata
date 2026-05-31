"use client"

import type { ComponentType } from "react"

import type { ProspectStatus } from "@/lib/validation/prospects"
import { Bell, CheckCircle2, MessageSquare, PenLine, Send, Timer } from "@/components/icons"
import { cn } from "@/lib/utils"

export type AttentionFilter = ProspectStatus | "stalled" | "followup_due"

export interface AttentionCounts {
  followup_due: number
  stalled: number
  estimate_sent: number
  changes_requested: number
  client_approved: number
  executed: number
}

interface AttentionItem {
  key: AttentionFilter
  count: number
  label: string
  icon: ComponentType<{ className?: string }>
  tone: string
}

interface PipelineAttentionStripProps {
  counts: AttentionCounts
  activeFilter?: AttentionFilter | null
  onSelect: (filter: AttentionFilter) => void
}

/** Compact, colored attention badges. Renders nothing when nothing needs attention. */
export function PipelineAttentionStrip({ counts, activeFilter, onSelect }: PipelineAttentionStripProps) {
  const items: AttentionItem[] = (
    [
      { key: "followup_due", count: counts.followup_due, label: "Follow-ups due", icon: Bell, tone: "text-rose-600 dark:text-rose-400 border-rose-500/40 bg-rose-500/10" },
      { key: "stalled", count: counts.stalled, label: "Stalled", icon: Timer, tone: "text-amber-600 dark:text-amber-400 border-amber-500/40 bg-amber-500/10" },
      { key: "changes_requested", count: counts.changes_requested, label: "Changes", icon: MessageSquare, tone: "text-orange-600 dark:text-orange-400 border-orange-500/40 bg-orange-500/10" },
      { key: "estimate_sent", count: counts.estimate_sent, label: "Awaiting client", icon: Send, tone: "text-blue-600 dark:text-blue-400 border-blue-500/40 bg-blue-500/10" },
      { key: "client_approved", count: counts.client_approved, label: "Countersign", icon: PenLine, tone: "text-violet-600 dark:text-violet-400 border-violet-500/40 bg-violet-500/10" },
      { key: "executed", count: counts.executed, label: "Convert", icon: CheckCircle2, tone: "text-emerald-600 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10" },
    ] satisfies AttentionItem[]
  ).filter((item) => item.count > 0)

  if (items.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((item) => {
        const Icon = item.icon
        const isActive = activeFilter === item.key
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onSelect(item.key)}
            aria-pressed={isActive}
            title={item.label}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-medium transition-all",
              item.tone,
              isActive ? "ring-1 ring-current/40" : "hover:brightness-[0.97]",
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="tabular-nums font-semibold">{item.count}</span>
            <span className="font-normal">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
