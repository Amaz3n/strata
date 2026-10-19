import "server-only";
import { z } from "zod";
import { requirePermission } from "./permissions";
import { recordEvent } from "./events";
import { listSyncTargets } from "./takeoff-destinations";
import {
  lineMeasurementSchema,
  planChangeResolutionSchema,
  takeoffDestinationSchema,
} from "@/lib/validation/takeoff";
import {
  getPreconWorkspace,
  authorizePreconWorkspaceWrite,
} from "./precon-workspace";
import { savePricingWorksheet } from "./precon-pricing";
import {
  createTakeoffCondition,
  getConditionLandingSheet,
  getConditionRollup,
  listTakeoffConditions,
  syncConditions,
} from "./takeoff";
import { QUANTITY_EPSILON } from "@/lib/drawings/measure";
import {
  measurementUnit,
  type MeasurementContext,
} from "@/lib/drawings/measurement-context";
import { planChanges, type PlanChanges } from "@/lib/precon/plan-changes";
import type { PricingRow, PricingWorksheet } from "@/lib/precon/pricing-worksheet";

/** Where a project's drawings were opened to measure for: a change order, an estimate or bid scope. */
export async function resolveMeasurementContext(
  projectId: string,
  query: { destination?: string; target?: string },
): Promise<MeasurementContext | undefined> {
  if (!query.destination || !query.target) return undefined;
  const destination = takeoffDestinationSchema.parse(query.destination);
  const targetId = z.string().uuid().parse(query.target);
  const target = (await listSyncTargets(projectId)).find(
    (target) => target.id === targetId && target.destination === destination,
  );
  if (!target)
    throw new Error(
      "This measurement destination does not belong to these plans.",
    );
  const base = `/projects/${projectId}`;
  return {
    destination,
    targetId,
    label: target.label,
    returnHref:
      destination === "pricing_worksheet"
        ? `/pipeline/${targetId}`
        : destination === "bid_scope"
          ? `${base}/bids/${targetId}`
          : destination === "change_order"
            ? `${base}/change-orders?changeOrder=${targetId}`
            : `/estimates?estimate=${targetId}`,
  };
}

const sourceOf = (row: PricingRow) =>
  (row.metadata.takeoff_source ?? row.metadata.takeoff) as
    | { condition_id?: string; detached?: boolean }
    | undefined;

/**
 * Before measuring a line: link it to the takeoff item its measurements go
 * into, creating one in the line's unit the first time. Saved before the
 * sheet opens so reopening the line reuses its item. Returns the sheet the
 * line was last measured on, when it has one, and whether the worksheet saved.
 */
export async function beginWorksheetMeasurement(
  prospectId: string,
  rowId: string,
  unit: string,
) {
  z.string().uuid().parse(rowId);
  const context = await authorizePreconWorkspaceWrite(prospectId);
  // A priced deal already has its project; provisioning only runs the first time.
  const [, projectId, workspace] = await Promise.all([
    requirePermission("takeoff.write", context),
    context.projectId ??
      import("./conversions").then(({ startProspectPricing }) =>
        startProspectPricing({ prospectId, resourcesOnly: true }).then((result) => result.projectId),
      ),
    getPreconWorkspace(prospectId),
  ]);
  const worksheet = workspace.pricing;
  const row = worksheet?.rows.find((row) => row.id === rowId);
  if (!worksheet || !row)
    throw new Error("Save this line before measuring it.");
  const source = sourceOf(row);
  const linkedId = !source?.detached ? source?.condition_id : undefined;
  const [conditions, linkedLanding] = await Promise.all([
    listTakeoffConditions({ project_id: projectId }),
    // Where to open is a convenience: a line whose item is gone gets a new one below.
    linkedId ? getConditionLandingSheet(linkedId).catch(() => null) : null,
  ]);
  const linked = conditions.find((item) => item.id === linkedId);
  if (linked)
    return {
      projectId,
      conditionId: linked.id,
      sheetId: linkedLanding?.drawing_sheet_id ?? null,
      saved: false,
    };
  const uom = measurementUnit(unit);
  if (!uom)
    throw new Error(
      "Choose an area, length, or count unit before measuring.",
    );
  if (uom === "cy" || uom === "ton")
    throw new Error(
      "Volume and weight are measured as an area with a depth. Measure this line in square feet.",
    );
  const condition = await createTakeoffCondition({
    project_id: projectId,
    name: row.description.slice(0, 120),
    uom,
    cost_code_id: row.cost_code_id,
  });
  row.metadata = {
    ...row.metadata,
    takeoff_source: { condition_id: condition.id, uom },
  };
  await savePricingWorksheet(prospectId, worksheet, workspace.version);
  // A new item has nothing measured, so nowhere to land.
  return { projectId, conditionId: condition.id, sheetId: null, saved: true };
}

async function loadLine(prospectId: string, rowId: string) {
  const workspace = await getPreconWorkspace(prospectId);
  const worksheet = workspace.pricing;
  const row = worksheet?.rows.find((item) => item.id === rowId);
  if (!worksheet || !row) throw new Error("This line was removed. Reload pricing and try again.");
  const conditionId = sourceOf(row)?.condition_id;
  if (!conditionId) throw new Error("Measure this line on the plans first.");
  return { workspace, worksheet, row, conditionId };
}

const quoted = (worksheet: PricingWorksheet, rowId: string) =>
  worksheet.requests.some((request) => request.quote && request.row_ids.includes(rowId));

/**
 * Done, in the measuring takeover. The line takes what was measured (with its
 * waste) and the rate set beside it, in one step — there is nothing else to
 * send. The builder measured on purpose, so a hand-typed quantity is replaced.
 */
export async function applyLineMeasurement(prospectId: string, input: unknown) {
  const parsed = lineMeasurementSchema.parse(input);
  const context = await authorizePreconWorkspaceWrite(prospectId);
  await requirePermission("takeoff.write", context);
  const { conditionId } = await loadLine(prospectId, parsed.row_id);
  await syncConditions({
    destination: "pricing_worksheet",
    target_id: prospectId,
    condition_ids: [conditionId],
    drift_resolution: { [conditionId]: "overwrite" },
  });
  const { workspace, worksheet, row } = await loadLine(prospectId, parsed.row_id);
  if (!row.metadata.takeoff) throw new Error("Nothing is measured for this line yet.");
  // A quoted line keeps the trade's price; the measurement is its evidence.
  if (!quoted(worksheet, row.id) && row.unit_cost_cents !== parsed.unit_cost_cents) {
    row.unit_cost_cents = parsed.unit_cost_cents;
    await savePricingWorksheet(prospectId, worksheet, workspace.version);
  }
  await recordEvent({
    orgId: context.orgId,
    eventType: "takeoff_condition_synced",
    entityType: "takeoff_condition",
    entityId: conditionId,
    payload: { destination: "pricing_worksheet", target_id: prospectId, row_id: row.id, quantity: row.quantity, unit_cost_cents: row.unit_cost_cents },
  });
}

/** What new plans did to a deal's measured lines. Nothing to read until a line has been measured. */
export async function loadDealPlanChanges(
  projectId: string | null,
  worksheet: PricingWorksheet | null,
): Promise<PlanChanges> {
  const measured = worksheet?.rows.filter((row) => (row.metadata.takeoff as { condition_id?: string } | undefined)?.condition_id) ?? [];
  if (!projectId || !worksheet || !measured.length) return { review: [], changed: [] };
  const rollups = await getConditionRollup({ project_id: projectId });
  return planChanges(
    worksheet.rows,
    rollups.map((rollup) => ({
      condition_id: rollup.condition.id,
      effective_quantity: rollup.effective_quantity,
      pending_review_count: rollup.pending_review_count,
      unscaled_markup_count: rollup.unscaled_markup_count,
    })),
  );
}

/**
 * After new plans: each changed line takes its new measured quantity, or
 * keeps its own. A kept line stays quiet until the plans move it again. The
 * quantity the review showed must still be what the plans say.
 */
export async function resolvePlanChanges(prospectId: string, input: unknown) {
  const parsed = planChangeResolutionSchema.parse(input);
  const context = await authorizePreconWorkspaceWrite(prospectId);
  await requirePermission("takeoff.write", context);
  const workspace = await getPreconWorkspace(prospectId);
  const changes = await loadDealPlanChanges(context.projectId ?? null, workspace.pricing ?? null);
  for (const line of parsed.lines) {
    const change = changes.changed.find((item) => item.rowId === line.row_id);
    if (!change || Math.abs(change.to - line.quantity) > QUANTITY_EPSILON)
      throw new Error("The plans changed again while you were reviewing. Review the latest quantities.");
  }
  const use = parsed.lines.filter((line) => line.choice === "use");
  const used = changes.changed.filter((change) => use.some((line) => line.row_id === change.rowId));
  if (used.length)
    await syncConditions({
      destination: "pricing_worksheet",
      target_id: prospectId,
      condition_ids: used.map((change) => change.conditionId),
      reviewed_quantities: Object.fromEntries(used.map((change) => [change.conditionId, change.to])),
      drift_resolution: Object.fromEntries(used.map((change) => [change.conditionId, "overwrite" as const])),
    });
  const keep = parsed.lines.filter((line) => line.choice === "keep");
  if (keep.length) {
    const latest = await getPreconWorkspace(prospectId);
    const worksheet = latest.pricing;
    if (!worksheet) throw new Error("Pricing is unavailable. Reload and try again.");
    for (const line of keep) {
      const row = worksheet.rows.find((item) => item.id === line.row_id);
      if (!row) throw new Error("A line was removed. Reload pricing and try again.");
      row.metadata = { ...row.metadata, takeoff: { ...(row.metadata.takeoff as Record<string, unknown>), kept_quantity: line.quantity } };
    }
    await savePricingWorksheet(prospectId, worksheet, latest.version);
  }
  await recordEvent({
    orgId: context.orgId,
    eventType: "deal_plan_changes_resolved",
    entityType: "prospect",
    entityId: prospectId,
    payload: { used: use.length, kept: keep.length },
  });
}

/** A worksheet's lines, for mapping measured items onto them from a project's drawings. */
export async function listMeasurementRows(prospectId: string) {
  const worksheet = (await getPreconWorkspace(prospectId)).pricing;
  return (worksheet?.rows ?? []).map((row) => ({
    id: row.id,
    label: row.description,
    unit: row.unit,
    conditionId: sourceOf(row)?.condition_id,
  }));
}
