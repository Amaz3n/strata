import "server-only";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireOrgContext } from "./context";
import { requirePermission } from "./permissions";
import { requireAuthorization } from "./authorization";
import { classifySyncRow } from "@/lib/drawings/condition-rollup";
import type { SyncConditionsInput } from "@/lib/validation/takeoff";
import type { ConditionRollup, SyncResult } from "./takeoff";
import { recordAudit } from "./audit";

/** Parent and lines commit together; the RPC rejects a changed/issued snapshot. */
export async function syncChangeOrderMeasurements(
  input: SyncConditionsInput,
  rollups: ConditionRollup[],
): Promise<SyncResult> {
  const context = await requireOrgContext();
  const { supabase, orgId, userId } = context;
  await requirePermission("takeoff.write", context);
  const { data: change, error } = await supabase
    .from("change_orders")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", input.target_id)
    .single();
  if (error || !change) throw new Error("Change order not found.");
  await requireAuthorization({
    ...context,
    projectId: change.project_id,
    permission: "change_order.write",
    resourceType: "change_order",
    resourceId: change.id,
  });
  if (
    !["draft", "pricing"].includes(change.lifecycle ?? "draft") ||
    change.status !== "draft" ||
    change.client_visible
  )
    throw new Error(
      "Only unissued draft changes can receive measured quantities.",
    );
  if (rollups.some((row) => row.condition.project_id !== change.project_id))
    throw new Error("Measurements belong to another project.");
  const { data: snapshot, error: lineError } = await supabase
    .from("change_order_lines")
    .select("*")
    .eq("org_id", orgId)
    .eq("change_order_id", change.id)
    .order("id");
  if (lineError) throw new Error("Unable to load change-order scope.");
  const result: SyncResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
  };
  const updates: Record<string, unknown>[] = [];
  for (const row of rollups) {
    const existing = snapshot?.find(
      (line) => line.metadata?.takeoff?.condition_id === row.condition.id,
    );
    const action = classifySyncRow({
      nextQuantity: row.effective_quantity,
      liveQuantity: existing ? Number(existing.quantity) : null,
      lastSyncedQuantity:
        existing?.metadata?.takeoff?.measured_quantity ?? null,
    });
    if (action === "unchanged") {
      result.unchanged++;
      continue;
    }
    if (
      existing?.commitment_change_order_id ||
      (action === "drift" &&
        input.drift_resolution?.[row.condition.id] !== "overwrite")
    ) {
      result.skipped++;
      continue;
    }
    if (row.effective_quantity <= 0)
      throw new Error(
        "A change-order quantity must be greater than zero. Review the measurement first.",
      );
    updates.push({
      id: existing?.id ?? crypto.randomUUID(),
      condition_id: row.condition.id,
      description: row.condition.name,
      quantity: row.effective_quantity,
      unit: row.condition.uom,
      unit_cost_cents:
        existing?.unit_cost_cents ?? row.effective_unit_cost_cents ?? 0,
      cost_code_id: existing?.cost_code_id ?? row.condition.cost_code_id,
      metadata: {
        ...existing?.metadata,
        takeoff: {
          condition_id: row.condition.id,
          condition_name: row.condition.name,
          measured_quantity: row.effective_quantity,
          net_quantity: row.measured_quantity,
          uom: row.condition.uom,
          waste_pct: row.condition.waste_pct,
          sheets: row.sheets,
          synced_at: new Date().toISOString(),
        },
      },
    });
    if (existing) result.updated++;
    else result.created++;
  }
  if (updates.length) {
    const { error: writeError } = await createServiceSupabaseClient().rpc(
      "apply_change_order_measurements",
      {
        p_org_id: orgId,
        p_actor_id: userId,
        p_change_id: change.id,
        p_updated_at: change.updated_at,
        p_snapshot: snapshot ?? [],
        p_updates: updates,
      },
    );
    if (writeError)
      throw new Error(`Unable to apply quantities: ${writeError.message}`);
    await recordAudit({
      orgId,
      actorId: userId,
      action: "update",
      entityType: "change_order",
      entityId: change.id,
      before: { lines: snapshot },
      after: { measured_lines: updates },
    });
  }
  return result;
}
