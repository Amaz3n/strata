import type { ConditionRollup } from "@/lib/services/takeoff";
import {
  CONDITION_UOMS,
  MEASURE_UOM_LABELS,
  QUANTITY_EPSILON,
} from "@/lib/drawings/measure";
import { Ruler, ExternalLink } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * Provenance a takeoff sync stamps onto every line it writes
 * (`metadata.takeoff`), on estimates, bid scope, and plan takeoff lines alike.
 */
export interface TakeoffProvenance {
  condition_id?: string;
  condition_name?: string;
  /**
   * Despite the name (kept for data compatibility), this is the WASTE-ADJUSTED
   * quantity — the same number the sync wrote to the line — which is what makes
   * it comparable against the line's live quantity.
   */
  measured_quantity?: number;
  waste_pct?: number;
  uom?: string;
  synced_at?: string;
  evidence_only?: boolean;
  net_quantity?: number;
  deduction_count?: number;
  measurement_count?: number;
  sheets?: {
    drawing_sheet_id: string;
    sheet_number: string;
    quantity: number;
  }[];
  detached?: boolean;
}

/** Unit as the takeoff stack spells it; unknown units pass through verbatim. */
function unitLabel(uom: string | undefined): string {
  if (!uom) return "";
  const known = CONDITION_UOMS.find((candidate) => candidate === uom);
  return known ? MEASURE_UOM_LABELS[known] : uom;
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
  prospectId,
  className,
  rowId,
  sourceMissing,
  measurement,
}: {
  metadata?: Record<string, any> | null;
  /** The line's current quantity, as edited — string or number, both accepted. */
  liveQuantity: number | string | null | undefined;
  /** Absent on prospect-scoped work, where there are no project drawings to link to. */
  projectId?: string | null;
  prospectId?: string | null;
  /** Spacing the host row needs; the badge renders nothing when there is no takeoff. */
  sourceMissing?: boolean;
  rowId?: string;
  measurement?: ConditionRollup;
  className?: string;
}) {
  const takeoff: TakeoffProvenance | undefined =
    metadata?.takeoff ?? metadata?.takeoff_source;
  if (!takeoff?.condition_id) return null;

  const measured = Number(takeoff.measured_quantity ?? 0);
  const current = Number(liveQuantity) || 0;
  const handEdited =
    !!takeoff.synced_at &&
    !takeoff.evidence_only &&
    Math.abs(current - measured) > QUANTITY_EPSILON;
  const unit = unitLabel(takeoff.uom);
  const changed =
    measurement &&
    takeoff.synced_at &&
    Math.abs(measurement.effective_quantity - measured) > QUANTITY_EPSILON;
  const needsReview =
    measurement &&
    (measurement.pending_review_count > 0 ||
      measurement.unscaled_markup_count > 0);
  const params = new URLSearchParams({
    condition: takeoff.condition_id,
    takeoff: "1",
  });
  if (prospectId && rowId) {
    params.set("destination", "pricing_worksheet");
    params.set("target", prospectId);
    params.set("row", rowId);
  }

  return (
    <div
      className={cn("flex flex-wrap items-center gap-2 text-[11px]", className)}
    >
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Ruler className="h-3 w-3" />
        {takeoff.synced_at
          ? takeoff.evidence_only
            ? "Scope measured"
            : "From plans"
          : "Measurement linked · not applied"}{" "}
        {takeoff.synced_at && (
          <span className="tabular-nums">
            {measured.toLocaleString("en-US", { maximumFractionDigits: 1 })}{" "}
            {unit}
          </span>
        )}
      </span>
      {takeoff.detached || sourceMissing ? (
        <span className="text-muted-foreground">
          Measurement source unavailable · saved quantity preserved
        </span>
      ) : handEdited ? (
        <span className="text-warning">Edited since the takeoff</span>
      ) : null}
      {needsReview ? (
        <span className="text-warning">Revised measurements need review</span>
      ) : changed ? (
        <span className="text-warning">
          Plans changed: {measured.toLocaleString()} →{" "}
          {measurement.effective_quantity.toLocaleString()} {unit}
        </span>
      ) : null}
      {takeoff.evidence_only && (
        <span className="text-muted-foreground">Quote price preserved</span>
      )}
      {takeoff.synced_at && (
        <details className="basis-full text-muted-foreground">
          <summary className="cursor-pointer">Measurement breakdown</summary>
          <div className="space-y-1 border-l pl-3 py-2">
            {takeoff.measurement_count !== undefined && (
              <p>
                {takeoff.measurement_count} measurements ·{" "}
                {takeoff.deduction_count ?? 0} deductions
              </p>
            )}
            {takeoff.net_quantity !== undefined && (
              <p>
                Net area / quantity: {takeoff.net_quantity.toLocaleString()}{" "}
                {unit} · Waste: {takeoff.waste_pct ?? 0}%
              </p>
            )}
            {(takeoff.sheets ?? measurement?.sheets ?? []).map((sheet) => (
              <p key={sheet.drawing_sheet_id}>
                {sheet.sheet_number} · {sheet.quantity.toLocaleString()} {unit}
              </p>
            ))}
            <p>Applied {new Date(takeoff.synced_at).toLocaleDateString()}</p>
          </div>
        </details>
      )}
      {(prospectId || projectId) && !takeoff.detached && !sourceMissing && (
        <a
          href={`${prospectId ? `/pipeline/${prospectId}/plans` : `/projects/${projectId}/drawings`}?${params}`}
          className="inline-flex items-center gap-0.5 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {needsReview || changed ? "Review changes" : "Show on plans"}
          <ExternalLink className="h-2.5 w-2.5" />
        </a>
      )}
    </div>
  );
}
