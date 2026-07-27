"use client"

import { useDraggable } from "@dnd-kit/core"

import { GripVertical } from "@/components/icons"
import { Checkbox } from "@/components/ui/checkbox"
import type { StartCandidateDTO, StartPackageListItemDTO } from "@/lib/services/starts"
import { cn } from "@/lib/utils"

/** dnd ids are namespaced so a drop handler can tell a lot from a package. */
export const CANDIDATE_PREFIX = "candidate:"

export function formatDay(value: string | null) {
  if (!value) return null
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  })
}

/** The one line that tells you what to do about this house. */
function statusLine(pkg: StartPackageListItemDTO) {
  if (pkg.status === "released") return "Released"
  if (pkg.status === "attention") return "Release failed"
  if (pkg.status === "releasing") return "Releasing…"
  // No gates at all is not the same as every gate cleared, and saying "ready"
  // for a package nobody ever gave requirements to would be a lie.
  if (pkg.gatesTotal === 0) return "No readiness gates"
  if (pkg.blocker) {
    return pkg.stalledDays > 0
      ? `${pkg.blocker.label} · ${pkg.stalledDays}d`
      : pkg.blocker.label
  }
  return "Ready to release"
}

function deadlineLine(pkg: StartPackageListItemDTO) {
  if (pkg.status === "released" || pkg.mustStartBy === null || pkg.daysToMustStart === null) return null
  if (pkg.daysToMustStart < 0) return `${Math.abs(pkg.daysToMustStart)}d past must-start`
  return `must start by ${formatDay(pkg.mustStartBy)}`
}

interface Props {
  pkg: StartPackageListItemDTO
  selected: boolean
  selectable: boolean
  draggable: boolean
  showCommunity: boolean
  onOpen: (id: string) => void
  onToggleSelect: (id: string) => void
}

export function StartCard({ pkg, selected, selectable, draggable, showCommunity, onOpen, onToggleSelect }: Props) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: pkg.id,
    disabled: !draggable,
    data: { targetWeek: pkg.targetWeek },
  })
  const ratio = pkg.gatesTotal > 0 ? pkg.gatesPassed / pkg.gatesTotal : 0
  const deadline = deadlineLine(pkg)

  return (
    <div
      ref={setNodeRef}
      className="lane-card group lane-settling"
      data-risk={pkg.risk}
      data-selected={selected}
      data-dragging={isDragging}
      data-released={pkg.status === "released"}
    >
      <div className="flex items-start gap-1.5">
        {draggable ? (
          <button
            type="button"
            {...listeners}
            {...attributes}
            aria-label={`Move ${pkg.communityName} ${pkg.lotLabel} to another week`}
            className="-ml-1 cursor-grab touch-none text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onOpen(pkg.id)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-[13px] font-medium leading-tight">
            {showCommunity ? `${pkg.communityName} · ` : ""}{pkg.lotLabel}
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground">
            {[pkg.planCode ?? pkg.planName, pkg.elevationCode].filter(Boolean).join(" / ") || "Plan not pinned"}
          </span>
        </button>
        {selectable ? (
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect(pkg.id)}
            aria-label={`Select ${pkg.lotLabel} for release`}
            className={cn(
              "mt-0.5 size-3.5 rounded-none opacity-0 transition-opacity group-hover:opacity-100 data-[state=checked]:opacity-100",
              selected && "opacity-100",
            )}
          />
        ) : null}
      </div>

      <p className="mt-1.5 truncate text-[11px] leading-tight">
        {pkg.sale.isSold ? (
          <span className="font-medium">SOLD{pkg.sale.buyerName ? ` · ${pkg.sale.buyerName}` : ""}</span>
        ) : (
          <span className="text-muted-foreground">SPEC</span>
        )}
      </p>

      <div className="mt-1.5 lane-meter" aria-hidden>
        <div className="lane-meter-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <p className="mt-1 truncate text-[11px] leading-tight text-muted-foreground">
        {statusLine(pkg)}
      </p>
      {deadline ? (
        <p className={cn(
          "truncate text-[11px] leading-tight tabular-nums",
          pkg.risk === "late" || pkg.risk === "at_risk" ? "font-medium" : "text-muted-foreground",
        )}>
          {deadline}
        </p>
      ) : null}
    </div>
  )
}

/**
 * A lot with no start package yet. It sits in the same queue as open packages
 * because in the meeting they are the same question — what fills this week?
 * Dragging one into a week opens its package and targets it in one motion.
 */
export function CandidateCard({ candidate, draggable, showCommunity, onOpen }: {
  candidate: StartCandidateDTO
  draggable: boolean
  showCommunity: boolean
  onOpen: (lotId: string) => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${CANDIDATE_PREFIX}${candidate.lotId}`,
    disabled: !draggable,
  })
  const late = candidate.daysToMustStart !== null && candidate.daysToMustStart < 0

  return (
    <div
      ref={setNodeRef}
      className="lane-card group border-dashed"
      data-risk={candidate.sale.isSold ? (late ? "late" : "at_risk") : "on_track"}
      data-dragging={isDragging}
    >
      <div className="flex items-start gap-1.5">
        {draggable ? (
          <button
            type="button"
            {...listeners}
            {...attributes}
            aria-label={`Open a start package for ${candidate.communityName} ${candidate.lotLabel} in a chosen week`}
            className="-ml-1 cursor-grab touch-none text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button type="button" onClick={() => onOpen(candidate.lotId)} className="min-w-0 flex-1 text-left">
          <span className="block truncate text-[13px] font-medium leading-tight">
            {showCommunity ? `${candidate.communityName} · ` : ""}{candidate.lotLabel}
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground">
            {candidate.planLabel ?? "Plan not pinned"}
          </span>
        </button>
      </div>
      <p className="mt-1.5 truncate text-[11px] leading-tight">
        {candidate.sale.isSold ? (
          <span className="font-medium">SOLD{candidate.sale.buyerName ? ` · ${candidate.sale.buyerName}` : ""}</span>
        ) : (
          <span className="text-muted-foreground">SPEC</span>
        )}
      </p>
      <p className={cn(
        "mt-1 truncate text-[11px] leading-tight tabular-nums",
        candidate.sale.isSold ? "font-medium" : "text-muted-foreground",
      )}>
        {candidate.sale.isSold
          ? candidate.daysToMustStart === null
            ? "Sold · no start package"
            : late
              ? `${Math.abs(candidate.daysToMustStart)}d past must-start`
              : `must start by ${formatDay(candidate.mustStartBy)}`
          : "No start package"}
      </p>
    </div>
  )
}
