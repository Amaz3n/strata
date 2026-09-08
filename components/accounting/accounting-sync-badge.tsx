import { AlertCircle, CheckCircle2, Clock, CloudOff, RefreshCw } from "lucide-react"

import { accountingProviderLabel, accountingProviderShortLabel } from "@/components/accounting/provider-label"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export type AccountingSyncStatus =
  | "not_synced"
  | "pending"
  | "processing"
  | "synced"
  | "accrued"
  | "exported"
  | "error"
  | "conflict"
  | "skipped"
  | "needs_review"
  | "disabled"

interface Props {
  /** Raw sync status from the record. Unknown values fall back to not_synced; null/undefined renders nothing. */
  status?: string | null
  /** Provider-side record id, shown in the tooltip when synced. */
  externalId?: string | null
  /** Last sync error, shown in the tooltip for error states. */
  error?: string | null
  /** Provider key of the connection this record syncs through, when the surface knows it. */
  provider?: string | null
  /** Provider display name, for connections whose label is not in the catalog (e.g. Arc Books). */
  providerLabel?: string | null
  /** ISO timestamp of the last successful sync, shown in the tooltip. */
  syncedAt?: string | null
  /** Icon-only round badge for dense table cells. */
  compact?: boolean
}

const STATUS_CONFIG: Record<
  AccountingSyncStatus,
  {
    icon: typeof CheckCircle2
    label: (provider: string, short: string) => string
    tone: string
    tooltip: (provider: string) => string
  }
> = {
  not_synced: {
    icon: CloudOff,
    label: () => "Not synced",
    tone: "border-border bg-muted text-muted-foreground",
    tooltip: (provider) => `Not synced to ${provider}`,
  },
  pending: {
    icon: Clock,
    label: () => "Pending sync",
    tone: "border-primary/20 bg-primary/10 text-primary",
    tooltip: (provider) => `Will sync to ${provider} within a few minutes`,
  },
  processing: {
    icon: RefreshCw,
    label: () => "Syncing…",
    tone: "border-primary/20 bg-primary/10 text-primary",
    tooltip: (provider) => `Syncing to ${provider}…`,
  },
  synced: {
    icon: CheckCircle2,
    label: (_provider, short) => short,
    tone: "border-success/20 bg-success/10 text-success",
    tooltip: (provider) => `Synced to ${provider}`,
  },
  accrued: {
    icon: Clock,
    label: () => "Awaiting export",
    tone: "border-primary/20 bg-primary/10 text-primary",
    tooltip: () => "Included in an open accounting batch. Export and import the file to record it in the external ledger.",
  },
  exported: {
    icon: CheckCircle2,
    label: () => "File exported",
    tone: "border-primary/20 bg-primary/10 text-primary",
    tooltip: () => "Exported in an accounting file. Posting in the external ledger has not been confirmed.",
  },
  error: {
    icon: AlertCircle,
    label: () => "Sync error",
    tone: "border-destructive/20 bg-destructive/10 text-destructive",
    // Never promise an indefinite retry: a push that exhausts its attempts stops
    // for good and only the sync queue can restart it.
    tooltip: (provider) => `Failed to sync to ${provider}. Arc retries a few times, then leaves it in the sync queue.`,
  },
  conflict: {
    icon: AlertCircle,
    label: () => "Conflict",
    tone: "border-warning/20 bg-warning/10 text-warning",
    tooltip: (provider) => `Arc and ${provider} disagree on this record. Review it in the sync queue, then resync.`,
  },
  skipped: {
    icon: CloudOff,
    label: () => "Not synced",
    tone: "border-border bg-muted text-muted-foreground",
    tooltip: (provider) => `No external change was required in ${provider}`,
  },
  needs_review: {
    icon: AlertCircle,
    label: () => "Needs review",
    tone: "border-warning/20 bg-warning/10 text-warning",
    tooltip: (provider) =>
      `${provider} needs a person on this record — it will not retry automatically. Resolve it in the sync queue, then resync.`,
  },
  disabled: {
    icon: CloudOff,
    label: () => "Sync disabled",
    tone: "border-border bg-muted text-muted-foreground",
    tooltip: (provider) => `${provider} sync is turned off`,
  },
}

function normalizeStatus(status: string): AccountingSyncStatus {
  return status in STATUS_CONFIG ? (status as AccountingSyncStatus) : "not_synced"
}

export function AccountingSyncBadge({
  status,
  externalId,
  error,
  provider,
  providerLabel,
  syncedAt,
  compact = false,
}: Props) {
  if (!status) return null

  const providerName = accountingProviderLabel(provider, providerLabel)
  const providerShort = accountingProviderShortLabel(provider, providerLabel)
  const normalized = normalizeStatus(status.toLowerCase())
  const { icon: Icon, label, tone, tooltip } = STATUS_CONFIG[normalized]

  const tooltipText =
    normalized === "synced" && syncedAt ? `Synced ${new Date(syncedAt).toLocaleString()}` : tooltip(providerName)
  const errorDetail = (normalized === "error" || normalized === "needs_review" || normalized === "conflict") && error ? error : null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={cn(tone, compact ? "h-6 w-6 cursor-help rounded-full p-0" : "gap-1 cursor-help")}>
          <Icon className={compact ? "mx-auto h-3 w-3" : "h-3 w-3"} />
          {!compact && label(providerName, providerShort)}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltipText}</p>
        {errorDetail && <p className="mt-1 max-w-xs text-xs opacity-70">{errorDetail}</p>}
        {externalId && normalized === "synced" && (
          <p className="mt-1 text-xs opacity-70">
            {providerShort} ID: {externalId}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
