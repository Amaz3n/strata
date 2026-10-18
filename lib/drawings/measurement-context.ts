import type { TakeoffDestination } from "@/lib/validation/takeoff";

/** A validated destination travels with the drawing session, never an arbitrary return URL. */
export interface MeasurementContext {
  destination: TakeoffDestination;
  targetId: string;
  label: string;
  returnHref: string;
  rowId?: string;
  rowLabel?: string;
  conditionId?: string;
}

export function measurementUnit(
  unit: string,
): "sf" | "sy" | "lf" | "ea" | "cy" | "sq" | "ton" | null {
  const normalized = unit
    .trim()
    .toLowerCase()
    .replace(/[ ._-]/g, "");
  const aliases: Record<
    string,
    "sf" | "sy" | "lf" | "ea" | "cy" | "sq" | "ton"
  > = {
    sf: "sf",
    sqft: "sf",
    ft2: "sf",
    sy: "sy",
    sqyd: "sy",
    yd2: "sy",
    lf: "lf",
    ft: "lf",
    linearfeet: "lf",
    ea: "ea",
    each: "ea",
    count: "ea",
    cy: "cy",
    yd3: "cy",
    sq: "sq",
    squares: "sq",
    ton: "ton",
    tons: "ton",
  };
  return aliases[normalized] ?? null;
}

export function measurementHref(
  projectId: string,
  context: MeasurementContext,
  prospectId?: string,
) {
  const params = new URLSearchParams({
    destination: context.destination,
    target: context.targetId,
    takeoff: "1",
  });
  if (context.rowId) params.set("row", context.rowId);
  if (context.conditionId) params.set("condition", context.conditionId);
  return `${prospectId ? `/pipeline/${prospectId}/plans` : `/projects/${projectId}/drawings`}?${params}`;
}
