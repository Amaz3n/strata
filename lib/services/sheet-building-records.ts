import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  SHEET_BUILDING_ENGINE_VERSION,
  reusableSheetBuildingRun,
  storableSheetBuildingRun,
  withSheetBuildingRun,
  type SheetBuildingRecord,
  type SheetBuildingRun,
  type StoredSheetBuildingRecord,
} from "@/lib/drawings/sheet-building-record"

/**
 * Persistence for the sheet building record (`sheet_building_records`, see
 * `lib/drawings/sheet-building-record.ts`). One row per sheet revision and
 * engine version, read by the area takeoff and the 3D model interpretation.
 *
 * Callers authorize before calling and pass their own client: the takeoff
 * runs behind `takeoff.read` with the member's client (RLS admits takeoff
 * readers, the same people who could already persist the derived detection
 * cache), the model interpretation is an outbox job with the service client.
 * The record is derived data — the engine's output for evidence the caller
 * already read — so writing it records no audit entry or event.
 */
export interface SheetBuildingScope {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  sheetVersionId: string
}

// The table ships in a migration that may not be applied yet. Only "relation
// does not exist" means that; every other database error is a real failure.
const MISSING_TABLE = new Set(["42P01", "PGRST205"])

async function readStored(scope: SheetBuildingScope): Promise<StoredSheetBuildingRecord & { id: string; updatedAt: string } | null | "unavailable"> {
  const { data, error } = await scope.supabase.from("sheet_building_records")
    .select("id, engine_version, input_key, record, updated_at")
    .eq("org_id", scope.orgId).eq("sheet_version_id", scope.sheetVersionId)
    .eq("engine_version", SHEET_BUILDING_ENGINE_VERSION).maybeSingle()
  if (error && MISSING_TABLE.has(error.code)) return "unavailable"
  if (error) throw new Error(`Could not read the sheet building record: ${error.message}`)
  if (!data) return null
  return { id: data.id, updatedAt: data.updated_at, engineVersion: data.engine_version, inputKey: data.input_key, record: data.record }
}

async function writeStored(
  scope: SheetBuildingScope,
  stored: (StoredSheetBuildingRecord & { id: string; updatedAt: string }) | null,
  inputKey: string,
  record: SheetBuildingRecord,
) {
  const { supabase } = scope
  // Optimistic: a concurrent writer that won keeps its run, and the run lost
  // here is simply computed again by the next reader that needs it.
  const { error } = stored
    ? await supabase.from("sheet_building_records").update({ input_key: inputKey, record })
      .eq("org_id", scope.orgId).eq("id", stored.id).eq("updated_at", stored.updatedAt)
    : await supabase.from("sheet_building_records").insert({
      org_id: scope.orgId, project_id: scope.projectId, sheet_version_id: scope.sheetVersionId,
      engine_version: SHEET_BUILDING_ENGINE_VERSION, input_key: inputKey, record,
    })
  if (error && error.code !== "23505") console.warn("[sheet-building-record] Could not store the record", error.message)
}

/**
 * The engine's run for this sheet revision: read from the record when it was
 * computed from the same evidence by the same engine, otherwise computed,
 * stored (when recognition completed) and returned. Returns `null` without
 * computing when the record table is not deployed, so the caller keeps its
 * pre-record behaviour.
 */
export async function ensureSheetBuildingRun(
  scope: SheetBuildingScope,
  key: { inputKey: string; runKey: string },
  compute: () => Promise<SheetBuildingRun>,
): Promise<SheetBuildingRun | null> {
  const stored = await readStored(scope)
  if (stored === "unavailable") return null
  const reusable = reusableSheetBuildingRun(stored, key.inputKey, key.runKey)
  if (reusable) return reusable
  const run = await compute()
  if (storableSheetBuildingRun(run)) await writeStored(scope, stored, key.inputKey, withSheetBuildingRun(stored, key.inputKey, key.runKey, run))
  return run
}
