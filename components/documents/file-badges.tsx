"use client"

/**
 * The state vocabulary of the Documents surfaces: approval status, signature
 * status, version currency, and portal sharing — plus the two pure resolvers
 * that feed them.
 *
 * Every Documents view (table, mobile list, explorer, properties panel) reads
 * its badges from here so one state never renders four different ways. Colour
 * reports state only: approved/signed → success, submitted → warning,
 * rejected → destructive, in review/sent → primary, dormant → muted.
 */

import type { ReactNode } from "react"
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Eye,
  FileSignature,
  HardHat,
  Lock,
  Upload,
  Users,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { FileWithUrls, ProjectFolderPermissions } from "@/app/(app)/documents/types"

/** `sm` sits in a dense table row; `md` sits in the properties panel. */
export type BadgeScale = "sm" | "md"

const SCALE_CLASS: Record<BadgeScale, string> = {
  sm: "h-4 gap-1 px-1 py-0 text-[10px] font-normal [&>svg]:size-2.5",
  md: "h-6 gap-1.5 px-2 text-xs font-medium [&>svg]:size-3",
}

type StateTone = "success" | "warning" | "destructive" | "active" | "partner" | "dormant"

const TONE_CLASS: Record<StateTone, string> = {
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  active: "border-primary/30 bg-primary/10 text-primary",
  /** A second audience, held apart from `active` so two share targets stay legible. */
  partner: "border-chart-5/30 bg-chart-5/10 text-chart-5",
  dormant: "border-border bg-muted/40 text-muted-foreground",
}

function StateBadge({
  tone,
  scale,
  icon: Icon,
  tooltip,
  className,
  children,
}: {
  tone: StateTone
  scale: BadgeScale
  icon: React.ElementType
  tooltip?: ReactNode
  className?: string
  children: ReactNode
}) {
  const badge = (
    <Badge
      variant="outline"
      className={cn(SCALE_CLASS[scale], TONE_CLASS[tone], className)}
    >
      <Icon />
      {children}
    </Badge>
  )

  if (!tooltip) return badge

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent>
          <p className="text-xs">{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function humanizeStatus(status: string): string {
  return status.replace(/_/g, " ")
}

// ---------------------------------------------------------------------------
// Approval status
// ---------------------------------------------------------------------------

const APPROVAL_STATE: Record<string, { tone: StateTone; icon: React.ElementType }> = {
  approved: { tone: "success", icon: CheckCircle2 },
  in_review: { tone: "active", icon: Eye },
  submitted: { tone: "warning", icon: Upload },
  rejected: { tone: "destructive", icon: AlertCircle },
  resubmit_required: { tone: "destructive", icon: AlertCircle },
}

/** Approval ladder. Renders nothing for a draft — a draft has no review state yet. */
export function FileStatusBadge({
  status,
  scale = "sm",
  tooltip,
}: {
  status?: string | null
  scale?: BadgeScale
  tooltip?: ReactNode
}) {
  if (!status || status === "draft") return null
  const state = APPROVAL_STATE[status] ?? { tone: "dormant" as const, icon: Clock }

  return (
    <StateBadge
      tone={state.tone}
      scale={scale}
      icon={state.icon}
      tooltip={tooltip ?? `Approval status: ${humanizeStatus(status)}`}
      className="capitalize"
    >
      {humanizeStatus(status)}
    </StateBadge>
  )
}

// ---------------------------------------------------------------------------
// Signature status
// ---------------------------------------------------------------------------

const SIGNATURE_TONE: Record<string, StateTone> = {
  signed: "success",
  sent: "active",
  draft: "warning",
  voided: "dormant",
  expired: "dormant",
}

/** Signature ladder. Always carries the pen icon so it never reads as approval. */
export function FileSignatureBadge({
  status,
  scale = "sm",
  tooltip,
}: {
  status?: string | null
  scale?: BadgeScale
  tooltip?: ReactNode
}) {
  if (!status) return null

  return (
    <StateBadge
      tone={SIGNATURE_TONE[status] ?? "dormant"}
      scale={scale}
      icon={FileSignature}
      tooltip={tooltip ?? `Signature status: ${humanizeStatus(status)}`}
      className="capitalize"
    >
      {humanizeStatus(status)}
    </StateBadge>
  )
}

// ---------------------------------------------------------------------------
// Version currency
// ---------------------------------------------------------------------------

export function FileVersionBadge({
  versionNumber,
  isCurrent,
  scale = "sm",
}: {
  versionNumber: number
  isCurrent: boolean
  scale?: BadgeScale
}) {
  return (
    <StateBadge
      tone={isCurrent ? "active" : "dormant"}
      scale={scale}
      icon={Clock}
      tooltip={
        isCurrent
          ? `Latest version (v${versionNumber})`
          : `Old version (v${versionNumber})`
      }
    >
      {isCurrent ? `v${versionNumber}` : "Superseded"}
    </StateBadge>
  )
}

// ---------------------------------------------------------------------------
// Portal sharing
// ---------------------------------------------------------------------------

export interface SharingTooltips {
  private?: string
  clients?: string
  subs?: string
}

/**
 * Who can see this file or folder outside the builder's team. `badge` is the
 * table/panel form; `icon` is the mobile row form, where there is no width for
 * words.
 */
export function FileSharingBadges({
  clients,
  subs,
  clientsLabel = "Clients",
  scale = "sm",
  variant = "badge",
  tooltips,
}: {
  clients: boolean
  subs: boolean
  clientsLabel?: string
  scale?: BadgeScale
  variant?: "badge" | "icon"
  tooltips?: SharingTooltips
}) {
  const isPrivate = !clients && !subs

  const privateLabel = tooltips?.private ?? "Private"
  const clientsLabelText = tooltips?.clients ?? `Shared with ${clientsLabel.toLowerCase()}`
  const subsLabelText = tooltips?.subs ?? "Shared with subs"

  if (variant === "icon") {
    if (isPrivate) {
      return (
        <span className="shrink-0" title={privateLabel}>
          <Lock className="h-3 w-3 text-muted-foreground" aria-label={privateLabel} />
        </span>
      )
    }
    return (
      <span className="flex shrink-0 items-center gap-1">
        {clients ? (
          <span title={clientsLabelText}>
            <Users className="h-3 w-3 text-primary" aria-label={clientsLabelText} />
          </span>
        ) : null}
        {subs ? (
          <span title={subsLabelText}>
            <HardHat className="h-3 w-3 text-chart-5" aria-label={subsLabelText} />
          </span>
        ) : null}
      </span>
    )
  }

  if (isPrivate) {
    return (
      <StateBadge tone="dormant" scale={scale} icon={Lock} tooltip={tooltips?.private}>
        Private
      </StateBadge>
    )
  }

  return (
    <>
      {clients ? (
        <StateBadge tone="active" scale={scale} icon={Users} tooltip={tooltips?.clients}>
          {clientsLabel}
        </StateBadge>
      ) : null}
      {subs ? (
        <StateBadge tone="partner" scale={scale} icon={HardHat} tooltip={tooltips?.subs}>
          Subs
        </StateBadge>
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// State resolvers
// ---------------------------------------------------------------------------

export interface FolderSharingState {
  share_with_clients: boolean
  share_with_subs: boolean
  /** True when the state comes from an ancestor folder rather than this one. */
  inherited: boolean
}

function normalizeFolderPath(path: string): string {
  return path.replace(/\/+/g, "/").replace(/\/$/, "")
}

/**
 * Sharing defaults for a folder: the deepest permission row that covers the
 * path wins, and anything above the exact path counts as inherited.
 */
export function getFolderSharingState(
  folderPermissions: ProjectFolderPermissions[],
  path: string,
): FolderSharingState {
  const normalizedPath = normalizeFolderPath(path)
  let bestMatch: FolderSharingState | null = null
  let bestMatchLength = -1

  for (const permission of folderPermissions) {
    const permissionPath = normalizeFolderPath(permission.path)
    const applies =
      normalizedPath === permissionPath || normalizedPath.startsWith(`${permissionPath}/`)
    if (!applies || permissionPath.length <= bestMatchLength) continue
    bestMatchLength = permissionPath.length
    bestMatch = {
      share_with_clients: permission.share_with_clients,
      share_with_subs: permission.share_with_subs,
      inherited: normalizedPath !== permissionPath,
    }
  }

  return bestMatch ?? { share_with_clients: false, share_with_subs: false, inherited: false }
}

/** The workflow record a file came from — a manual upload is the last resort. */
export function getPrimarySourceContext(file: FileWithUrls) {
  const contexts = file.source_contexts ?? []
  return contexts.find((context) => context.type !== "manual_upload") ?? contexts[0] ?? null
}
