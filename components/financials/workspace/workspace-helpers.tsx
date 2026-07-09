import { Badge } from "@/components/ui/badge"

export function formatMoneyFromCents(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

const QBO_BADGE_MAP: Record<string, { label: string; tone: string }> = {
  synced: { label: "Synced to QuickBooks", tone: "bg-success/10 text-success border-success/20" },
  pending: { label: "Pending Sync", tone: "bg-primary/10 text-primary border-primary/20" },
  error: { label: "Sync Error", tone: "bg-destructive/10 text-destructive border-destructive/20" },
  needs_review: { label: "Requires Review", tone: "bg-warning/10 text-warning border-warning/20" },
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
