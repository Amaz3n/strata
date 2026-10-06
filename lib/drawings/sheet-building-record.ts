import { createHash } from "node:crypto";
import { AREA_ENGINE_VERSION, type AreaDetection, type AreaFinishPolicy, type AreaInput } from "./area-takeoff";
import type { AreaEngineResult } from "./area-engine";
import { BUILDING_RECONSTRUCTION_VERSION } from "./building-reconstruction";
import { mergeArchitecturalTextRuns } from "./raster-text";

/**
 * The sheet building record — what the recognition engine found on ONE sheet
 * revision (rooms, walls, openings, the building reconstruction), stored once
 * and read by both the area takeoff and the 3D model interpretation.
 *
 * Only whole-sheet runs without user boundaries belong here: a crop or a
 * hand-drawn boundary is a different question asked of the engine. Within a
 * sheet the engine still has two caller-chosen knobs that change its answer —
 * the finish policy and whether visual recognition runs — so the record keeps
 * one run per combination, all computed from the same source evidence
 * (`inputKey`). New evidence or a recalibrated scale replaces every run.
 */
export const SHEET_BUILDING_ENGINE_VERSION = `${AREA_ENGINE_VERSION}.${BUILDING_RECONSTRUCTION_VERSION}`;

export type SheetBuildingInterpretation = "hybrid" | "vector";
export interface SheetBuildingRun {
  detection: AreaDetection;
  recognition: AreaEngineResult["recognition"];
}
export interface SheetBuildingRecord {
  runs: Record<string, SheetBuildingRun>;
}
export interface StoredSheetBuildingRecord {
  engineVersion: string;
  inputKey: string;
  record: SheetBuildingRecord;
}

export function sheetBuildingRunKey(finishPolicy: AreaFinishPolicy, interpretation: SheetBuildingInterpretation): string {
  return `${finishPolicy}:${interpretation}`;
}

/** Fingerprint of everything the engine reads from the sheet. Text runs are
 * hashed after the engine's own (idempotent) raster-text merge, so callers
 * that pre-merge and callers that do not agree on the key. */
export function sheetBuildingInputKey(
  input: Pick<AreaInput, "segments" | "flags" | "textRuns" | "evidence" | "imageWidth" | "imageHeight" | "feetPerImagePx">,
): string {
  const segments = Float32Array.from(input.segments);
  const flags = Uint8Array.from(input.flags ?? []);
  return createHash("sha256")
    .update(JSON.stringify([input.imageWidth, input.imageHeight, input.feetPerImagePx]))
    .update(new Uint8Array(segments.buffer))
    .update(flags)
    .update(JSON.stringify(mergeArchitecturalTextRuns(input.textRuns, input.evidence?.rasterText?.runs ?? [])))
    .update(JSON.stringify(input.evidence ?? null))
    .digest("hex");
}

/** The stored run, only when it was computed by this engine from this exact evidence. */
export function reusableSheetBuildingRun(
  stored: StoredSheetBuildingRecord | null,
  inputKey: string,
  runKey: string,
): SheetBuildingRun | null {
  if (!stored || stored.engineVersion !== SHEET_BUILDING_ENGINE_VERSION || stored.inputKey !== inputKey) return null;
  const run = stored.record.runs?.[runKey];
  return run && run.detection?.engine === AREA_ENGINE_VERSION ? run : null;
}

/** A partial or unavailable recognition must stay retryable, never become the record. */
export function storableSheetBuildingRun(run: SheetBuildingRun): boolean {
  return run.recognition !== "partial" && run.recognition !== "unavailable";
}

/** Adds a run to the record; a record of other evidence is replaced, not merged. */
export function withSheetBuildingRun(
  stored: StoredSheetBuildingRecord | null,
  inputKey: string,
  runKey: string,
  run: SheetBuildingRun,
): SheetBuildingRecord {
  const runs = stored && stored.engineVersion === SHEET_BUILDING_ENGINE_VERSION && stored.inputKey === inputKey
    ? stored.record.runs ?? {}
    : {};
  return { runs: { ...runs, [runKey]: run } };
}
