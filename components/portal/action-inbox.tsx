import Link from "next/link"
import { CheckCircle2, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

export type ActionTone = "critical" | "warning" | "info"

export interface PortalAction {
  id: string
  tone: ActionTone
  label: string
  detail?: string
  href: string
}

/**
 * Rank order for the inbox: what is late, then what is due, then what is
 * merely waiting. Callers push actions in any order and sort with this.
 */
const TONE_RANK: Record<ActionTone, number> = {
  critical: 0,
  warning: 1,
  info: 2,
}

export function sortPortalActions(actions: PortalAction[]): PortalAction[] {
  return [...actions].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone])
}

const TONE_MARKER: Record<ActionTone, string> = {
  critical: "bg-destructive",
  warning: "bg-warning",
  info: "bg-muted-foreground",
}

interface PortalActionInboxProps {
  actions: PortalAction[]
  /** Shown when nothing is outstanding. */
  emptyMessage?: string
}

/**
 * The one thing a sub or buyer opens the portal to see: what is on them right
 * now, ranked, each row a direct link to the page that clears it.
 */
export function PortalActionInbox({
  actions,
  emptyMessage = "Nothing needs your attention right now.",
}: PortalActionInboxProps) {
  if (actions.length === 0) {
    return (
      <div className="flex items-center gap-3 border border-border bg-card px-4 py-5">
        <CheckCircle2 className="size-5 shrink-0 text-success" />
        <div>
          <p className="text-sm font-medium text-foreground">You are all caught up</p>
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold text-foreground">Needs your attention</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{actions.length}</span>
      </div>
      <ul className="divide-y divide-border">
        {actions.map((action) => (
          <li key={action.id}>
            <Link
              href={action.href}
              className="group flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-muted"
            >
              <span
                className={cn("size-2 shrink-0 rounded-full", TONE_MARKER[action.tone])}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {action.label}
                </span>
                {action.detail ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {action.detail}
                  </span>
                ) : null}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
