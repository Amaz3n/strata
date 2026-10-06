import "server-only";
import { z } from "zod";
import { requirePermission } from "./permissions";
import { listSyncTargets } from "./takeoff-destinations";
import { takeoffDestinationSchema } from "@/lib/validation/takeoff";
import {
  getPreconWorkspace,
  authorizePreconWorkspaceWrite,
} from "./precon-workspace";
import { savePricingWorksheet } from "./precon-pricing";
import { createTakeoffCondition, listTakeoffConditions } from "./takeoff";
import {
  measurementHref,
  measurementUnit,
  type MeasurementContext,
} from "@/lib/drawings/measurement-context";

export async function resolveMeasurementContext(
  projectId: string,
  query: { destination?: string; target?: string; row?: string },
  prospectId?: string,
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
  const context: MeasurementContext = {
    destination,
    targetId,
    label: target.label,
    returnHref:
      destination === "pricing_worksheet"
        ? `/pipeline/${targetId}`
        : destination === "bid_scope"
          ? prospectId
            ? `/pipeline/${prospectId}/quotes/${targetId}`
            : `${base}/bids/${targetId}`
          : destination === "change_order"
            ? `${base}/change-orders?changeOrder=${targetId}`
            : `/estimates?estimate=${targetId}`,
  };
  if (query.row && destination === "pricing_worksheet") {
    const row = (await getPreconWorkspace(targetId)).pricing?.rows.find(
      (row) => row.id === z.string().uuid().parse(query.row),
    );
    if (!row)
      throw new Error(
        "The scope item was removed. Return to the estimate to choose another item.",
      );
    const source = (row.metadata.takeoff_source ?? row.metadata.takeoff) as
      | { condition_id?: string }
      | undefined;
    context.returnHref = `/pipeline/${targetId}?row=${row.id}`;
    Object.assign(context, {
      rowId: row.id,
      rowLabel: row.description,
      conditionId: source?.condition_id,
    });
  }
  return context;
}

/** Save/link before navigating so retrying or reopening the row reuses its item. */
export async function beginWorksheetMeasurement(
  prospectId: string,
  rowId: string,
  unit: string,
) {
  z.string().uuid().parse(rowId);
  const context = await authorizePreconWorkspaceWrite(prospectId);
  await requirePermission("takeoff.write", context);
  const { startProspectPricing } = await import("./conversions");
  const { projectId } = await startProspectPricing({
    prospectId,
    resourcesOnly: true,
  });
  const workspace = await getPreconWorkspace(prospectId);
  const worksheet = workspace.pricing;
  const row = worksheet?.rows.find((row) => row.id === rowId);
  if (!worksheet || !row)
    throw new Error("Save this scope item before measuring it.");
  const source = (row.metadata.takeoff_source ?? row.metadata.takeoff) as
    | { condition_id?: string; detached?: boolean }
    | undefined;
  const conditions = await listTakeoffConditions({ project_id: projectId });
  let condition = !source?.detached
    ? conditions.find((item) => item.id === source?.condition_id)
    : undefined;
  if (!condition) {
    const uom = measurementUnit(unit);
    if (!uom)
      throw new Error(
        "Choose an area, length, or count unit before measuring.",
      );
    if (uom === "cy" || uom === "ton")
      throw new Error(
        "Create a volume takeoff item on the plans and set its depth before linking it here.",
      );
    condition = await createTakeoffCondition({
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
  }
  return measurementHref(
    projectId,
    {
      destination: "pricing_worksheet",
      targetId: prospectId,
      label: "Working estimate",
      returnHref: `/pipeline/${prospectId}`,
      rowId,
      conditionId: condition.id,
    },
    prospectId,
  );
}

export async function listMeasurementRows(prospectId: string) {
  const worksheet = (await getPreconWorkspace(prospectId)).pricing;
  return (worksheet?.rows ?? []).map((row) => ({
    id: row.id,
    label: row.description,
    unit: row.unit,
    conditionId: (
      (row.metadata.takeoff_source ?? row.metadata.takeoff) as
        | { condition_id?: string }
        | undefined
    )?.condition_id,
  }));
}
