import { AlertCircle, CheckCircle2, Clock, CloudOff } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type QBOSyncStatus = "pending" | "synced" | "error" | "skipped" | null | undefined

interface Props {
  status: QBOSyncStatus
  syncedAt?: string | null
  qboId?: string | null
}

export function QBOSyncBadge({ status, syncedAt, qboId }: Props) {
  if (!status) return null

  const config = {
    pending: {
      icon: Clock,
      label: "Syncing…",
      variant: "secondary" as const,
      tooltip: "Invoice will sync to QuickBooks within a few minutes",
    },
    synced: {
      icon: CheckCircle2,
      label: "QBO",
      variant: "outline" as const,
      tooltip: syncedAt ? `Synced ${new Date(syncedAt).toLocaleString()}` : "Synced to QuickBooks",
    },
    error: {
      icon: AlertCircle,
      label: "Sync error",
      variant: "destructive" as const,
      tooltip: "Failed to sync to QuickBooks. Will retry automatically.",
    },
    skipped: {
      icon: CloudOff,
      label: "Not synced",
      variant: "secondary" as const,
      tooltip: "QuickBooks sync disabled or not connected",
    },
  } as const

  const { icon: Icon, label, variant, tooltip } = config[status]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} className="gap-1 cursor-help">
          <Icon className="w-3 h-3" />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <p>{tooltip}</p>
        {qboId && status === "synced" && <p className="text-xs opacity-70 mt-1">QBO ID: {qboId}</p>}
      </TooltipContent>
    </Tooltip>
  )
}
