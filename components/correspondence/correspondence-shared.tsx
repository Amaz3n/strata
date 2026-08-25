"use client"

import {
  CLASSIFICATION_LABELS,
  type CorrespondenceClassification,
  type CorrespondenceClassifiedBy,
  type CorrespondenceDirection,
} from "@/lib/correspondence"
import { Badge } from "@/components/ui/badge"
import { Mail, Send } from "@/components/icons"
import { cn } from "@/lib/utils"

export function formatTimestamp(value: string | null) {
  if (!value) return "—"
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

/**
 * The list's date column. Deliberately absolute: an age ("3d") reads better but
 * only exists relative to now, and reading the clock while the shell prerenders
 * both breaks the build and bakes a stale answer into the page. The exact
 * timestamp rides along in the cell's title.
 */
export function formatDate(value: string | null) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function formatBytes(value: number | null) {
  if (!value) return ""
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Only `co_trigger` carries colour: it is the one classification that means
 * someone has to act. The rest are categories, and colour here is state.
 */
export function ClassificationBadge({
  classification,
  className,
}: {
  classification: CorrespondenceClassification
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] font-normal",
        classification === "co_trigger" && "border-warning/30 bg-warning/15 text-warning",
        className,
      )}
    >
      {CLASSIFICATION_LABELS[classification]}
    </Badge>
  )
}

/**
 * `classified_by` is the difference between "a model guessed this", "nobody has
 * looked" and "a person decided". On a log that gets read back during a
 * dispute, that distinction belongs on the row.
 */
export function ReviewState({
  classifiedBy,
  confidence,
}: {
  classifiedBy: CorrespondenceClassifiedBy
  confidence: number | null
}) {
  if (classifiedBy === "user") {
    return <span className="text-xs text-muted-foreground">Confirmed</span>
  }
  if (classifiedBy === "system") {
    return <span className="text-xs text-warning">Needs review</span>
  }
  return (
    <span className="text-xs text-warning">
      AI{confidence === null ? "" : ` · ${Math.round(confidence * 100)}%`}
    </span>
  )
}

export function DirectionIcon({
  direction,
  className,
}: {
  direction: CorrespondenceDirection
  className?: string
}) {
  const Icon = direction === "outbound" ? Send : Mail
  return (
    <Icon
      className={cn("size-3.5 shrink-0 text-muted-foreground", className)}
      aria-label={direction === "outbound" ? "Sent" : "Received"}
    />
  )
}
