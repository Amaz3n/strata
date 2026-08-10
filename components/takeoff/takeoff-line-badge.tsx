import { CONDITION_UOMS, MEASURE_UOM_LABELS, QUANTITY_EPSILON } from "@/lib/drawings/measure"
import { Ruler, ExternalLink } from "@/components/icons"
import { cn } from "@/lib/utils"

/**
 * Provenance a takeoff sync stamps onto every line it writes
 * (`metadata.takeoff`), on estimates, bid scope, and plan takeoff lines alike.
 */
export interface TakeoffProvenance {
  condition_id?: string
  condition_name?: string
  /**
   * Despite the name (kept for data compatibility), this is the WASTE-ADJUSTED
   * quantity — the same number the sync wrote to the line — which is what makes
   * it comparable against the line's live quantity.
   */
  measured_quantity?: number
  waste_pct?: number
  uom?: string
  synced_at?: string
  detached?: boolean
}

/** Unit as the takeoff stack spells it; unknown units pass through verbatim. */
function unitLabel(uom: string | undefined): string {
  if (!uom) return ""
  const known = CONDITION_UOMS.find((candidate) => candidate === uom)
  return known ? MEASURE_UOM_LABELS[known] : uom
}

/**
 * "This number was measured, not typed."
 *
 * Shown on any line carrying `metadata.takeoff`, with a deep link back to the
 * drawings viewer in takeoff mode with the condition armed. If the quantity has
 * since been hand-edited, the badge says so — otherwise a re-sync would look
 * like it lost someone's change.
 */
export function TakeoffLineBadge({
  metadata,
  liveQuantity,
  projectId,
  className,
}: {
  metadata?: Record<string, any> | null
  /** The line's current quantity, as edited — string or number, both accepted. */
  liveQuantity: number | string | null | undefined
  /** Absent on prospect-scoped work, where there are no project drawings to link to. */
  projectId?: string | null
  /** Spacing the host row needs; the badge renders nothing when there is no takeoff. */
  className?: string
}) {
  const takeoff: TakeoffProvenance | undefined = metadata?.takeoff
  if (!takeoff?.condition_id) return null

  const measured = Number(takeoff.measured_quantity ?? 0)
  const current = Number(liveQuantity) || 0
  const handEdited = Math.abs(current - measured) > QUANTITY_EPSILON
  const unit = unitLabel(takeoff.uom)

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-[11px]", className)}>
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Ruler className="h-3 w-3" />
        Measured{" "}
        <span className="tabular-nums">
          {measured.toLocaleString("en-US", { maximumFractionDigits: 1 })} {unit}
        </span>
      </span>
      {takeoff.detached ? (
        <span className="text-muted-foreground">Takeoff condition deleted</span>
      ) : handEdited ? (
        <span className="text-warning">Edited since the takeoff</span>
      ) : null}
      {projectId && !takeoff.detached && (
        <a
          href={`/projects/${projectId}/drawings?condition=${takeoff.condition_id}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Show on plans
          <ExternalLink className="h-2.5 w-2.5" />
        </a>
      )}
    </div>
  )
}
