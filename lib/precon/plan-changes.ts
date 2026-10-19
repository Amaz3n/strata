import { QUANTITY_EPSILON } from "@/lib/drawings/measure";
import type { PricingRow } from "./pricing-worksheet";

/** The parts of a condition's rollup a line's measured quantity is checked against. */
export type MeasuredSource = {
  condition_id: string;
  effective_quantity: number;
  pending_review_count: number;
  unscaled_markup_count: number;
};

/** A measured line whose measurement now reads differently from the quantity on the line. */
export type PlanChange = {
  rowId: string;
  conditionId: string;
  description: string;
  unit: string;
  from: number;
  to: number;
  /** What using the new quantity does to the line's cost, at the line's own rate. */
  deltaCents: number;
};

export type PlanChanges = {
  /** Measured lines with measurements a revision carried onto new sheets, waiting on a person. */
  review: Array<{ rowId: string; description: string; count: number }>;
  changed: PlanChange[];
};

type Takeoff = { condition_id?: string; detached?: boolean; measured_quantity?: number; kept_quantity?: number };

const takeoffOf = (row: PricingRow) => row.metadata.takeoff as Takeoff | undefined;

/** The condition a line was measured from, once its quantity came off the plans. */
export function measuredConditionId(row: PricingRow) {
  const takeoff = takeoffOf(row);
  return takeoff?.condition_id && !takeoff.detached ? takeoff.condition_id : null;
}

/**
 * What new plans did to the price. A revision carries measurements onto the
 * new sheets for a person to confirm; until then the line is under review, not
 * changed, because the rollup leaves unconfirmed members out and would read
 * low. Once confirmed, a line is changed when the measurement no longer matches
 * the quantity it wrote — unless the builder chose to keep the line at this
 * exact measurement.
 */
export function planChanges(rows: PricingRow[], sources: MeasuredSource[]): PlanChanges {
  const byCondition = new Map(sources.map((source) => [source.condition_id, source]));
  const result: PlanChanges = { review: [], changed: [] };
  for (const row of rows) {
    const conditionId = measuredConditionId(row);
    const source = conditionId ? byCondition.get(conditionId) : undefined;
    if (!conditionId || !source) continue;
    const waiting = source.pending_review_count + source.unscaled_markup_count;
    if (waiting) {
      result.review.push({ rowId: row.id, description: row.description, count: waiting });
      continue;
    }
    const takeoff = takeoffOf(row);
    const from = Number(takeoff?.measured_quantity ?? row.quantity);
    const to = source.effective_quantity;
    if (Math.abs(to - from) <= QUANTITY_EPSILON) continue;
    if (takeoff?.kept_quantity !== undefined && Math.abs(takeoff.kept_quantity - to) <= QUANTITY_EPSILON) continue;
    result.changed.push({
      rowId: row.id,
      conditionId,
      description: row.description,
      unit: row.unit,
      from,
      to,
      deltaCents: Math.round((to - from) * (row.unit_cost_cents ?? 0)),
    });
  }
  return result;
}
