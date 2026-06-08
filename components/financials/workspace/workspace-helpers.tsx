import { Badge } from "@/components/ui/badge"

export function formatMoneyFromCents(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

const QBO_BADGE_MAP: Record<string, { label: string; tone: string }> = {
  synced: { label: "Synced to QuickBooks", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" },
  pending: { label: "Pending Sync", tone: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20" },
  error: { label: "Sync Error", tone: "bg-destructive/10 text-destructive border-destructive/20" },
  needs_review: { label: "Requires Review", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20" },
  skipped: { label: "Sync Disabled", tone: "bg-muted text-muted-foreground border-border" },
  not_synced: { label: "Not Synced", tone: "bg-muted text-muted-foreground border-border" },
}

/** Shared QuickBooks sync-status badge for the financial workspaces. */
export function qboBadge(status?: string | null, error?: string | null) {
  const normalized = (status ?? "not_synced").toLowerCase()
  const config = QBO_BADGE_MAP[normalized] ?? QBO_BADGE_MAP.not_synced
  return (
    <Badge variant="outline" title={error ?? undefined} className={`text-[10px] font-bold uppercase tracking-tight ${config.tone}`}>
      {config.label}
    </Badge>
  )
}
